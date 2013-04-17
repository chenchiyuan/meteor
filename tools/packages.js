var path = require('path');
var _ = require('underscore');
var files = require('./files.js');
var bundler = require('./bundler.js');
var project = require('./project.js');
var meteorNpm = require('./meteor_npm.js');
var linker = require(path.join(__dirname, 'linker.js'));
var fs = require('fs');

// Find all files under `rootPath` that have an extension in
// `extensions` (an array of extensions without leading dot), and
// return them as a list of paths relative to sourceRoot. Ignore files
// that match a regexp in the ignoreFiles array, if given. As a
// special case (ugh), push all html files to the head of the list.
var scanForSources = function (rootPath, extensions, ignoreFiles) {
  var self = this;

  // find everything in tree, sorted depth-first alphabetically.
  var fileList = files.file_list_sync(rootPath, extensions);
  fileList = _.reject(fileList, function (file) {
    return _.any(ignoreFiles || [], function (pattern) {
      return file.match(pattern);
    });
  });
  fileList.sort(files.sort);

  // XXX HUGE HACK --
  // push html (template) files ahead of everything else. this is
  // important because the user wants to be able to say
  // Template.foo.events = { ... }
  //
  // maybe all of the templates should go in one file? packages
  // should probably have a way to request this treatment (load
  // order dependency tags?) .. who knows.
  var htmls = [];
  _.each(fileList, function (filename) {
    if (path.extname(filename) === '.html') {
      htmls.push(filename);
      fileList = _.reject(fileList, function (f) { return f === filename;});
    }
  });
  fileList = htmls.concat(fileList);

  // now make everything relative to rootPath
  var prefix = rootPath;
  if (prefix[prefix.length - 1] !== path.sep)
    prefix += path.sep;

  return fileList.map(function (abs) {
    if (path.relative(prefix, abs).match(/\.\./))
      // XXX audit to make sure it works in all possible symlink
      // scenarios
      throw new Error("internal error: source file outside of parent?");
    return abs.substr(prefix.length);
  });
};

///////////////////////////////////////////////////////////////////////////////
// Slice
///////////////////////////////////////////////////////////////////////////////

// Options:
// - name [required]
// - arch [required]
// - uses
// - sources
// - forceExport
// - dependencyInfo
//
// Do not include the source files in dependencyInfo. They will be
// added at compile time when the sources are actually read.
var Slice = function (pkg, options) {
  var self = this;
  self.pkg = pkg;

  // Name for this slice. For example, the "client" in "ddp.client"
  // (which, NB, we might load on server arches.)
  self.sliceName = options.name;

  // "client" or "server"
  self.arch = options.arch;

  // Unique ID for this slice. Unique across all slices of all
  // packages, but constant across reloads of this slice.
  self.id = pkg.id + "." + options.name + "@" + self.arch;

  // Packages used. The ordering is significant only for determining
  // import symbol priority (it doesn't affect load order), and a
  // given package could appear more than once in the list, so code
  // that consumes this value will need to guard appropriately. Each
  // element in the array has keys:
  // - spec: either 'packagename' or 'packagename.slicename'
  // - unordered: If true, we don't want the package's imports and we
  //   don't want to force the package to load before us. We just want
  //   to ensure that it loads if we load.
  self.uses = options.uses;

  // This slice's source files. Array of paths.
  self.sources = options.sources || [];

  // Symbols that this slice should export even if @export directives
  // don't appear in the source code. List of symbols (as strings.)
  self.forceExport = options.forceExport || [];

  // Files and directories that we want to monitor for changes in
  // development mode, such as source files and package.js, in the
  // format accepted by watch.Watcher.
  self.dependencyInfo = options.dependencyInfo ||
    { files: {}, directories: {} };

  // Has this slice been compiled?
  self.isCompiled = false;

  // All symbols exported from the JavaScript code in this
  // package. Array of string symbol (eg "Foo", "Bar.baz".) Set only
  // after _ensureCompiled().
  self.exports = null;

  // Prelink output. 'boundary' is a magic cookie used for inserting
  // imports. 'prelinkFiles' is the partially linked JavaScript
  // code. Both of these are inputs into the final link phase, which
  // inserts the final JavaScript resources into 'resources'. Set only
  // after _ensureCompiled().
  self.boundary = null;
  self.prelinkFiles = null;

  // All of the data provided for eventual inclusion in the bundle,
  // other than JavaScript that still needs to be fed through the
  // final link stage. A list of objects with these keys:
  //
  // type: "js", "css", "head", "body", "static"
  //
  // data: The contents of this resource, as a Buffer. For example,
  // for "head", the data to insert in <head>; for "js", the
  // JavaScript source code (which may be subject to further
  // processing such as minification); for "static", the contents of a
  // static resource such as an image.
  //
  // servePath: The (absolute) path at which the resource would prefer
  // to be served. Interpretation varies by type. For example, always
  // honored for "static", ignored for "head" and "body", sometimes
  // honored for CSS but ignored if we are concatenating. Set only
  // after _ensureCompiled().
  self.resources = null;
};

_.extend(Slice.prototype, {
  // Add more source files. 'sources' is an array of paths. Cannot be
  // called after _ensureCompiled().
  addSources: function (sources) {
    var self = this;
    if (self.isCompiled)
      throw new Error("Too late to add sources");
    self.sources = self.sources.concat(sources);
  },

  // Process all source files through the appropriate handlers and run
  // the prelink phase on any resulting JavaScript. Also add all
  // provided source files to the package dependencies. Sets fields
  // such as dependencies, exports, boundary, prelinkFiles, and
  // resources. Idempotent.
  _ensureCompiled: function () {
    var self = this;
    var isApp = ! self.pkg.name;

    if (self.isCompiled)
      return;

    var resources = [];
    var js = [];

    /**
     * In the legacy extension API, this is the ultimate low-level
     * entry point to add data to the bundle.
     *
     * type: "js", "css", "head", "body", "static"
     *
     * path: the (absolute) path at which the file will be
     * served. ignored in the case of "head" and "body".
     *
     * source_file: the absolute path to read the data from. if
     * path is set, will default based on that. overridden by
     * data.
     *
     * data: the data to send. overrides source_file if
     * present. you must still set path (except for "head" and
     * "body".)
     */
    var add_resource = function (options) {
      var sourceFile = options.source_file || options.path;

      var data;
      if (options.data) {
        data = options.data;
        if (!(data instanceof Buffer)) {
          if (!(typeof data === "string"))
            throw new Error("Bad type for data");
          data = new Buffer(data, 'utf8');
        }
      } else {
        if (!sourceFile)
          throw new Error("Need either source_file or data");
        data = fs.readFileSync(sourceFile);
      }

      if (options.where && options.where !== self.arch)
        throw new Error("'where' is deprecated here and if provided " +
                        "must be '" + self.arch + "'");

      if (options.type === "js") {
        js.push({
          source: data.toString('utf8'),
          servePath: options.path
        });
      } else {
        resources.push({
          type: options.type,
          data: data,
          servePath: options.path
        });
      }
    };

    _.each(self.sources, function (relPath) {
      var absPath = path.resolve(self.pkg.sourceRoot, relPath);
      var ext = path.extname(relPath).substr(1);
      var handler = self._getSourceHandler(ext);
      var contents = fs.readFileSync(absPath);
      self.dependencyInfo.files[absPath] = bundler.sha1(contents);

      if (! handler) {
        // If we don't have an extension handler, serve this file
        // as a static resource.
        resources.push({
          type: "static",
          data: contents,
          servePath: path.join(self.pkg.serveRoot, relPath)
        });
        return;
      }

      handler({add_resource: add_resource},
              // XXX take contents instead of a path
              path.join(self.pkg.sourceRoot, relPath),
              path.join(self.pkg.serveRoot, relPath),
              self.arch);
    });

    // Phase 1 link
    var results = linker.prelink({
      inputFiles: js,
      useGlobalNamespace: isApp,
      combinedServePath: isApp ? null :
        "/packages/" + self.pkg.name +
        (self.sliceName === "main" ? "" : ("." + self.sliceName)) + ".js",
      // XXX report an error if there is a package called global-imports
      importStubServePath: '/packages/global-imports.js',
      name: self.pkg.name || null,
      forceExport: self.forceExport
    });

    self.prelinkFiles = results.files;
    self.boundary = results.boundary;
    self.exports = results.exports;
    self.resources = resources;
    self.isCompiled = true;
  },

  // Get the resources that this function contributes to a bundle, in
  // the same format as self.resources as documented above. This
  // includes static assets and fully linked JavaScript.
  //
  // It is when you call this function that we read our dependent
  // packages and commit to whatever versions of them we currently
  // have in the library -- at least for the purpose of imports, which
  // is resolved at bundle time. (On the other hand, when it comes to
  // the extension handlers we'll use, we previously commited to those
  // versions at package build ('compile') time.)
  getResources: function () {
    var self = this;
    var library = self.pkg.library;
    self._ensureCompiled();

    // Compute imports by merging the exports of all of the packages
    // we use. Note that in the case of conflicting symbols, later
    // packages get precedence.
    var imports = {}; // map from symbol to supplying package name
    _.each(_.values(self.uses), function (u) {
      if (! u.unordered) {
        _.each(library.getSlices(u.spec, self.arch), function (otherSlice) {
          otherSlice._ensureCompiled(); // make sure otherSlice.exports is valid
          _.each(otherSlice.exports, function (symbol) {
            imports[symbol] = otherSlice.pkg.name;
          });
        });
      }
    });

    // Phase 2 link
    var isApp = ! self.pkg.name;
    var files = linker.link({
      imports: imports,
      useGlobalNamespace: isApp,
      prelinkFiles: self.prelinkFiles,
      boundary: self.boundary
    });

    // Add each output as a resource
    var jsResources = _.map(files, function (file) {
      return {
        type: "js",
        data: new Buffer(file.source, 'utf8'),
        servePath: file.servePath
      };
    });

    return _.union(self.resources, jsResources); // union preserves order
  },

  // Get all extensions handlers registered in this slice, as a map
  // from extension (no leading dot) to handler function. Throws an
  // exception if two packages are registered for the same extension.
  _allHandlers: function () {
    var self = this;
    var ret = {};

    // XXX we used to include our own extensions only if we were the
    // "use" role. now we include them everywhere because we don't
    // have a special "use" role anymore. it's not totally clear to me
    // what the correct behavior should be -- we need to resolve
    // whether we think about extensions as being global to a package
    // or particular to a slice.
    _.extend(ret, self.pkg.extensions);

    _.each(self.uses, function (u) {
      var otherPkg = self.pkg.library.get(u.spec.split('.')[0]);
      _.each(otherPkg.extensions, function (handler, ext) {
        if (ext in ret && ret[ext] !== handler)
          // XXX do something more graceful than printing a stack
          // trace and exiting!! we have higher standards than that!
          throw new Error("Conflict: two packages included in " +
                          (self.pkg.name || "your app") + ", " +
                          (ret[ext].pkg.name || "your app") + " and " +
                          (otherPkg.name || "your app") + ", " +
                          "are both trying to handle ." + ext);
        ret[ext] = handler;
      });
    });

    return ret;
  },

  // Return a list of all of the extension that indicate source files
  // for this slice, not including leading dots. Computed based on
  // this.uses, so should only be called once that has been set.
  registeredExtensions: function () {
    var self = this;
    return _.keys(self._allHandlers());
  },

  // Find the function that should be used to handle a source file for
  // this slice, or return null if there isn't one. We'll use handlers
  // that are defined in this package and in its immediate
  // dependencies. ('extension' should be the extension of the file
  // without a leading dot.)
  _getSourceHandler: function (extension) {
    var self = this;
    return (self._allHandlers())[extension] || null;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Packages
///////////////////////////////////////////////////////////////////////////////

var nextPackageId = 1;
var Package = function (library) {
  var self = this;

  // Fields set by init_*:
  // name: package name, or null for an app pseudo-package or collection
  // sourceRoot: base directory for resolving source files, null for collection
  // serveRoot: base directory for serving files, null for collection

  // A unique ID (guaranteed to not be reused in this process -- if
  // the package is reloaded, it will get a different id the second
  // time)
  self.id = nextPackageId++;

  // The path from which this package was loaded
  self.sourceRoot = null;

  // XXX needs docs
  self.serveRoot = null;

  // Package library that should be used to resolve this package's
  // dependencies
  self.library = library;

  // Package metadata. Keys are 'summary' and 'internal'.
  self.metadata = {};

  // npm packages used by this package. Map from npm package name to
  // npm version (as a string)
  self.npmDependencies = null;

  // File handler extensions defined by this package. Map from file
  // extension to the handler function.
  self.extensions = {};

  // Available editions/subpackages ("slices") of this package. Array
  // of Slice.
  self.slices = [];

  // Are we in the warehouse? Used to skip npm re-scans.
  // XXX this is probably connected to isCompiled; it was originally created on
  // a different branch from isCompiled
  // XXX NOTE: this is set by Library reaching into us
  self.inWarehouse = false;

  // True if we've run installNpmDependencies. (It's slow and there's
  // no need to do it more than once.)
  self.npmUpdated = false;

  // Map from an arch to the list of slice names that should be
  // included by default if this package is used without specifying a
  // slice (eg, as "ddp" rather than "ddp.server").
  self.defaultSlices = {};

  // Map from an arch to the list of slice names that should be
  // included when this package is tested.
  self.testSlices = {};
};

_.extend(Package.prototype, {
  // Return the slice of the package to use for a given slice name
  // (eg, 'main' or 'test') and architecture (right now 'client' and
  // 'server', but in the future these will be real architectures), or
  // throw an exception if that packages can't be loaded under these
  // circumstances.
  getSingleSlice: function (name, arch) {
    var self = this;

    var ret = _.find(self.slices, function (slice) {
      return slice.sliceName === name && slice.arch === arch;
    });

    if (! ret) {
      // XXX need improvement. The user should get a graceful error
      // message, not an exception, and all of this talk of slices an
      // architectures is likely to be confusing/overkill in many
      // contexts.
      throw new Error((self.name || "This app") +
                      " does not have a slice named '" + name +
                      "' that runs on architecture '" + arch + "'");
    }

    return ret;
  },

  // Return the slices that should be used on a given arch if the
  // package is named without any qualifiers (eg, 'ddp' rather than
  // 'ddp.client').
  getDefaultSlices: function (arch) {
    var self = this;
    return _.map(self.defaultSlices[arch], function (name) {
      return self.getSingleSlice(name, arch);
    });
  },

  // Return the slices that should be used to test the package on a
  // given arch.
  getTestSlices: function (arch) {
    var self = this;
    return _.map(self.testSlices[arch], function (name) {
      return self.getSingleSlice(name, arch);
    });
  },

  // loads a package's package.js file into memory, using
  // runInThisContext. Wraps the contents of package.js in a closure,
  // supplying pseudo-globals 'Package' and 'Npm'.
  initFromPackageDir: function (name, dir) {
    var self = this;
    self.name = name;
    self.sourceRoot = dir;
    self.serveRoot = path.join(path.sep, 'packages', name);

    if (!fs.existsSync(self.sourceRoot))
      throw new Error("The package named " + self.name + " does not exist.");

    var roleHandlers = {use: null, test: null};

    var packageJsPath = path.join(self.sourceRoot, 'package.js');
    var code = fs.readFileSync(packageJsPath);
    var packageJsHash = bundler.sha1(code);
    // \n is necessary in case final line is a //-comment
    var wrapped = "(function(Package,Npm){" + code.toString() + "\n})";
    // See #runInThisContext
    //
    // XXX it'd be nice to runInNewContext so that the package
    // setup code can't mess with our globals, but objects that
    // come out of runInNewContext have bizarro antimatter
    // prototype chains and break 'instanceof Array'. for now,
    // steer clear
    var func = require('vm').runInThisContext(wrapped, packageJsPath, true);
    func({
      // == 'Package' object visible in package.js ==

      // Set package metadata. Options:
      // - summary: for 'meteor list'
      // - internal: if true, hide in list
      // There used to be a third option documented here,
      // 'environments', but it was never implemented and no package
      // ever used it.
      describe: function (options) {
        _.extend(self.metadata, options);
      },

      on_use: function (f) {
        if (roleHandlers.use)
          throw new Error("A package may have only one on_use handler");
        roleHandlers.use = f;
      },

      on_test: function (f) {
        if (roleHandlers.test)
          throw new Error("A package may have only one on_test handler");
        roleHandlers.test = f;
      },

      // extension doesn't contain a dot
      register_extension: function (extension, callback) {
        if (_.has(self.extensions, extension))
          throw new Error("This package has already registered a handler for " +
                          extension);
        self.extensions[extension] = callback;
      },

      // Same as node's default `require` but is relative to the
      // package's directory. Regular `require` doesn't work well
      // because we read the package.js file and `runInThisContext` it
      // separately as a string.  This means that paths are relative
      // to the top-level meteor.js script rather than the location of
      // package.js
      _require: function(filename) {
        return require(path.join(self.sourceRoot, filename));
      }
    }, {
      // == 'Npm' object visible in package.js ==
      depends: function (npmDependencies) {
        if (self.npmDependencies)
          throw new Error("Can only call `Npm.depends` once in package " +
                          self.name + ".");

        // don't allow npm fuzzy versions so that there is complete
        // consistency when deploying a meteor app
        //
        // XXX use something like seal or lockdown to have *complete*
        // confidence we're running the same code?
        meteorNpm.ensureOnlyExactVersions(npmDependencies);

        self.npmDependencies = npmDependencies;
      },

      require: function (name) {
        var nodeModuleDir = path.join(self.sourceRoot,
                                      '.npm', 'node_modules', name);
        if (fs.existsSync(nodeModuleDir)) {
          return require(nodeModuleDir);
        } else {
          try {
            return require(name); // from the dev bundle
          } catch (e) {
            throw new Error("Can't find npm module '" + name +
                            "'. Did you forget to call 'Npm.depends'?");
          }
        }
      }
    });

    // source files used
    var sources = {use: {client: [], server: []},
                   test: {client: [], server: []}};

    // symbols force-exported
    var forceExport = {use: {client: [], server: []},
                       test: {client: [], server: []}};

    // packages used (keys are 'name' and 'unordered')
    var uses = {use: {client: [], server: []},
                test: {client: [], server: []}};

    // For this old-style, on_use/on_test/where-based package, figure
    // out its dependencies by calling its on_xxx functions and seeing
    // what it does.
    //
    // We have a simple strategy. Call its on_xxx handler with no
    // 'where', which is what happens when the package is added
    // directly to an app, and see what files it adds to the client
    // and the server. Call the former the client version of the
    // package, and the latter the server version. Then, when a
    // package is used, include it in both the client and the server
    // by default. This simple strategy doesn't capture even 10% of
    // the complexity possible with on_use, on_test, and where, but
    // probably is sufficient for virtually all packages that actually
    // exist in the field, if not every single
    // one. #OldStylePackageSupport
    _.each(["use", "test"], function (role) {
      if (roleHandlers[role]) {
        roleHandlers[role]({
          // Called when this package wants to make another package be
          // used. Can also take literal package objects, if you have
          // anonymous packages you want to use (eg, app packages)
          //
          // options can include:
          //
          // - role: defaults to "use", but you could pass something
          //   like "test" if for some reason you wanted to include a
          //   package's tests
          //
          // - unordered: if true, don't require this package to load
          //   before us -- just require it to be loaded anytime. Also
          //   don't bring this package's imports into our
          //   namespace. If false, override a true value specified in
          //   a previous call to use for this package name. (A
          //   limitation of the current implementation is that this
          //   flag is not tracked per-environment or per-role.)  This
          //   option can be used to resolve circular dependencies in
          //   exceptional circumstances, eg, the 'meteor' package
          //   depends on 'handlebars', but all packages (including
          //   'handlebars') have an implicit dependency on
          //   'meteor'. Internal use only -- future support of this
          //   is not guaranteed. #UnorderedPackageReferences
          use: function (names, where, options) {
            options = options || {};

            if (!(names instanceof Array))
              names = names ? [names] : [];

            if (!(where instanceof Array))
              where = where ? [where] : ["client", "server"];

            _.each(names, function (name) {
              _.each(where, function (arch) {
                if (options.role && options.role !== "use")
                  throw new Error("Role override is no longer supported");
                uses[role][arch].push({
                  spec: name,
                  unordered: options.unordered || false
                });
              });
            });
          },

          // Top-level call to add a source file to a package. It will
          // be processed according to its extension (eg, *.coffee
          // files will be compiled to JavaScript.)
          add_files: function (paths, where) {
            if (!(paths instanceof Array))
              paths = paths ? [paths] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(paths, function (path) {
              _.each(where, function (arch) {
                sources[role][arch].push(path);
              });
            });
          },

          // Force the export of a symbol from this package. An
          // alternative to using @export directives. Possibly helpful
          // when you don't want to modify the source code of a third
          // party library.
          //
          // @param symbols String (eg "Foo", "Foo.bar") or array of String
          // @param where 'client', 'server', or an array of those
          exportSymbol: function (symbols, where) {
            if (!(symbols instanceof Array))
              symbols = symbols ? [symbols] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(symbols, function (symbol) {
              _.each(where, function (arch) {
                forceExport[role][arch].push(symbol);
              });
            });
          },
          error: function () {
            throw new Error("api.error(), ironically, is no longer supported");
          },
          registered_extensions: function () {
            throw new Error(
              "api.registered_extensions() is no longer supported");
          }
        });
      }
    });

    // Create slices
    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (arch) {
        // Everything depends on the package 'meteor', which sets up
        // the basic environment) (except 'meteor' itself).
        if (! (name === "meteor" && role === "use")) {
          // Don't add the dependency if one already exists. This
          // allows the package to create an unordered dependency and
          // override the one that we'd add here. This is necessary to
          // resolve the circular dependency between meteor and
          // underscore (underscore depends weakly on meteor; it just
          // needs the .js extension handler.)
          var alreadyDependsOnMeteor =
            !! _.find(uses[role][arch], function (u) {
              return u.spec === "meteor";
            });
          if (! alreadyDependsOnMeteor)
            uses[role][arch].unshift({ spec: "meteor" });
        }

        // We need to create a separate (non ===) copy of
        // dependencyInfo for each slice.
        var dependencyInfo = { files: {}, directories: {} };
        dependencyInfo.files[packageJsPath] = packageJsHash;

        self.slices.push(new Slice(self, {
          name: ({ use: "main", test: "tests" })[role],
          arch: arch,
          uses: uses[role][arch],
          sources: sources[role][arch],
          forceExport: forceExport[role][arch],
          dependencyInfo: dependencyInfo
        }));
      });
    });

    // Default slices
    self.defaultSlices = { client: ['main'], server: ['main'] };
    self.testSlices = { client: ['tests'], server: ['tests'] };
  },

  initFromAppDir: function (appDir, ignoreFiles) {
    var self = this;
    appDir = path.resolve(appDir);
    self.name = null;
    self.sourceRoot = appDir;
    self.serveRoot = path.sep;

    _.each(["client", "server"], function (arch) {
      // Determine used packages
      var names = _.union(
          // standard client packages for the classic meteor stack.
          // XXX remove and make everyone explicitly declare all dependencies
          ['meteor', 'deps', 'session', 'livedata', 'mongo-livedata',
           'spark', 'templating', 'startup', 'past'],
        project.get_packages(appDir));

      // Create slice
      var slice = new Slice(self, {
        name: "app",
        arch: arch,
        uses: _.map(names, function (name) {
          return { spec: name }
        })
      });
      self.slices.push(slice);

      // Watch control files for changes
      // XXX this read has a race with the actual read that is used
      _.each([path.join(appDir, '.meteor', 'packages'),
              path.join(appDir, '.meteor', 'releases')], function (p) {
                if (fs.existsSync(p)) {
                  slice.dependencyInfo.files[p] =
                    bundler.sha1(fs.readFileSync(p));
                }
              });

      // Determine source files
      var allSources = scanForSources(
        self.sourceRoot, slice.registeredExtensions(),
        ignoreFiles || []);

      var withoutAppPackages = _.reject(allSources, function (sourcePath) {
        // Skip files that are in app packages. (Directories named "packages"
        // lower in the tree are OK.)
        return sourcePath.match(/^packages\//);
      });

      var otherArch = (arch === "server") ? "client" : "server";
      var withoutOtherArch =
        _.reject(withoutAppPackages, function (sourcePath) {
          return (path.sep + sourcePath + path.sep).indexOf(
            path.sep + otherArch + path.sep) !== -1;
        });

      var tests = false; /* for now */
      var withoutOtherRole =
        _.reject(withoutOtherArch, function (sourcePath) {
          var isTest =
            ((path.sep + sourcePath + path.sep).indexOf(
              path.sep + 'tests' + path.sep) !== -1);
          return isTest !== (!!tests);
        });

      slice.addSources(withoutOtherRole);

      // Directories to monitor for new files
      slice.dependencyInfo.directories[appDir] = {
        include: _.map(slice.registeredExtensions(), function (ext) {
          return new RegExp('\\.' + ext + "$");
        }),
        exclude: ignoreFiles
      };

      // Inside the packages directory, only look for new packages
      // (which we can detect by the appearance of a package.js file.)
      // Other than that, packages explicitly call out the files they
      // use.
      slice.dependencyInfo.directories[path.resolve(appDir, 'packages')] = {
        include: [ /^package\.js$/ ],
        exclude: ignoreFiles
      };

      // Exclude .meteor/local and everything under it.
      slice.dependencyInfo.directories[
        path.resolve(appDir, '.meteor', 'local')] = { exclude: [/.?/] };
    });

    self.defaultSlices = { client: ['app'], server: ['app'] };
  },

  // Called when this package wants to ensure certain npm dependencies
  // are installed for use within server code.
  //
  // @param npmDependencies {Object} eg {gcd: "0.0.0", tar: "0.1.14"}
  installNpmDependencies: function(quiet) {
    var self = this;

    // Nothing to do if there's no Npm.depends().
    if (!self.npmDependencies)
      return;

    // Warehouse packages come with their NPM dependencies and are read-only.
    if (self.inWarehouse)
      return;

    // No need to do it more than once.
    if (self.npmUpdated)
      return;

    // go through a specialized npm dependencies update process, ensuring we
    // don't get new versions of any (sub)dependencies. this process also runs
    // mostly safely multiple times in parallel (which could happen if you have
    // two apps running locally using the same package)
    meteorNpm.updateDependencies(
      self.name, self.npmDir(), self.npmDependencies, quiet);

    self.npmUpdated = true;
  },

  npmDir: function () {
    return path.join(this.sourceRoot, '.npm');
  }
});

var packages = exports;
_.extend(exports, {
  Package: Package
});
