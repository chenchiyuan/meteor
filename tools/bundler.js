// Bundle contents:
// main.js [run to start the server]
// /static [served by node for now]
// /static_cacheable [cache-forever files, served by node for now]
// /server [XXX split out into a package]
//   server.js, .... [contents of tools/server]
//   node_modules [for now, contents of (dev_bundle)/lib/node_modules]
// /app.html
// /app [user code]
// /app.json: [data for server.js]
//  - load [list of files to load, relative to root, presumably under /app]
//  - manifest [list of resources in load order, each consists of an object]:
//     {
//       "path": relative path of file in the bundle, normalized to use forward slashes
//       "where": "client", "internal"  [could also be "server" in future]
//       "type": "js", "css", or "static"
//       "cacheable": (client) boolean, is it safe to ask the browser to cache this file
//       "url": (client) relative url to download the resource, includes cache
//              busting param if used
//       "size": size in bytes
//       "hash": sha1 hash of the contents
//     }
//
// The application launcher is expected to execute /main.js with node, setting
// various environment variables (such as PORT and MONGO_URL). The enclosed node
// application is expected to do the rest, including serving /static.

var path = require('path');
var files = require(path.join(__dirname, 'files.js'));
var packages = require(path.join(__dirname, 'packages.js'));
var linker = require(path.join(__dirname, 'linker.js'));
var crypto = require('crypto');
var fs = require('fs');
var uglify = require('uglify-js');
var cleanCSS = require('clean-css');
var _ = require('underscore');
var project = require(path.join(__dirname, 'project.js'));

// files to ignore when bundling. node has no globs, so use regexps
var ignoreFiles = [
    /~$/, /^\.#/, /^#.*#$/,
    /^\.DS_Store$/, /^ehthumbs\.db$/, /^Icon.$/, /^Thumbs\.db$/,
    /^\.meteor$/, /* avoids scanning N^2 files when bundling all packages */
    /^\.git$/ /* often has too many files to watch */
];

var sha1 = exports.sha1 = function (contents) {
  var hash = crypto.createHash('sha1');
  hash.update(contents);
  return hash.digest('hex');
};


///////////////////////////////////////////////////////////////////////////////
// Slice
///////////////////////////////////////////////////////////////////////////////

// Holds the resources that a package is contributing to a bundle, for
// a particular role ('use' or 'test') and a particular where
// ('client' or 'server').
var Slice = function (pkg, role, where) {
  var self = this;
  self.pkg = pkg;

  // "use" in the normal case (this object represents the instance of
  // a package in a bundle), or "test" if this instead represents an
  // instance of the package's tests.
  self.role = role;

  // "client" or "server"
  self.where = where;
};

///////////////////////////////////////////////////////////////////////////////
// Bundle
///////////////////////////////////////////////////////////////////////////////

// options to include:
//
// - releaseStamp: the Meteor release name to write into the bundle metadata
// - library: tells you how to find packages
var Bundle = function (options) {
  var self = this;

  // All of the Slices that are to go into this bundle, in the order
  // that they are to be loaded.
  self.slices = [];

  // meteor release version
  self.releaseStamp = options.releaseStamp;

  // search configuration for package.get()
  self.library = options.library;

  // map from environment, to list of filenames
  self.js = {client: [], server: []};

  // list of filenames
  self.css = [];

  // images and other static files added from packages
  // map from environment, to list of filenames
  self.static = {client: [], server: []};

  // Map from environment, to path name (server relative), to contents
  // of file as buffer.
  self.files = {client: {}, clientCacheable: {}, server: {}};

  // See description of the manifest at the top.
  // Note that in contrast to self.js etc., the manifest only includes
  // files which are in the final bundler output: for example, if code
  // is minified, the manifest includes the minify output file but not
  // the individual input files that were combined.
  self.manifest = [];

  // these directories are copied (cp -r) or symlinked into the
  // bundle. maps target path (server relative) to source directory on
  // disk
  self.nodeModulesDirs = {};

  // list of segments of additional HTML for <head>/<body>
  self.head = [];
  self.body = [];

  // Files and paths used by the bundle, in the format returned by
  // bundle().dependencyInfo.
  self.dependencyInfo = null;
};

_.extend(Bundle.prototype, {
  // Determine the packages to load, create Slices for
  // them, put them in load order, save in slices.
  //
  // contents is a map from role ('use' or 'test') to environment
  // ('client' or 'server') to an array of either package names or
  // actual Package objects.
  determineLoadOrder: function (contents) {
    var self = this;

    // Package slices being used. Map from a role string (eg, "use" or
    // "test") to "client" or "server" to a package id to a Slice.
    var sliceIndex = {use: {client: {}, server: {}},
                    test: {client: {}, server: {}}};
    var slicesUnordered = [];

    // Ensure that slices exist for a package and its dependencies.
    var add = function (pkg, role, where) {
      if (sliceIndex[role][where][pkg.id])
        return;
      var slice = new Slice(pkg, role, where);
      sliceIndex[role][where][pkg.id] = slice;
      slicesUnordered.push(slice);
      _.each(pkg.uses[role][where], function (usedPkgName) {
        var usedPkg = self.getPackage(usedPkgName);
        add(usedPkg, "use", where);
      });
    };

    // Add the provided roots and all of their dependencies.
    _.each(contents, function (whereToArray, role) {
      _.each(whereToArray, function (packageList, where) {
        _.each(packageList, function (packageOrPackageName) {
          var pkg = self.getPackage(packageOrPackageName);
          add(pkg, role, where);
        });
      });
    });

    // Take unorderedSlices as input, put it in order, and save it to
    // self.slices. "In order" means that if X depends on (uses) Y,
    // and that relationship is not marked as unordered, Y appears
    // before X in the ordering. Raises an exception iff there is no
    // such ordering (due to circular dependency.)
    var id = function (slice) {
      return slice.role + ":" + slice.where + ":" + slice.pkg.id;
    };

    var done = {};
    var remaining = {};
    var onStack = {};
    _.each(slicesUnordered, function (slice) {
      remaining[id(slice)] = slice;
    });

    while (true) {
      // Get an arbitrary package from those that remain, or break if
      // none remain
      var first = undefined;
      for (first in remaining)
        break;
      if (first === undefined)
        break;
      first = remaining[first];

      // Emit that package and all of its dependencies
      var load = function (slice) {
        if (done[id(slice)])
          return;

        _.each(slice.pkg.uses[slice.role][slice.where], function (usedPkgName) {
          if (slice.pkg.name && slice.pkg.unordered[usedPkgName])
            return;
          var usedPkg = self.getPackage(usedPkgName);
          var usedSlice = sliceIndex.use[slice.where][usedPkg.id];
          if (! usedSlice)
            throw new Error("Missing slice?");
          if (onStack[id(usedSlice)]) {
            console.error("fatal: circular dependency between packages " +
                          slice.pkg.name + " and " + usedSlice.pkg.name);
            process.exit(1);
          }
          onStack[id(usedSlice)] = true;
          load(usedSlice);
          delete onStack[id(usedSlice)];
        });
        self.slices.push(slice);
        done[id(slice)] = true;
        delete remaining[id(slice)];
      };
      load(first);
    }
  },

  prepNodeModules: function () {
    var self = this;
    var seen = {};
    _.each(self.slices, function (slice) {
      // Bring npm dependencies up to date. One day this will probably
      // grow into a full-fledged package build step.
      if (slice.pkg.npmDependencies && ! seen[slice.pkg.id]) {
        seen[slice.pkg.id] = true;
        slice.pkg.installNpmDependencies();
        self.bundleNodeModules(slice.pkg);
      }
    });
  },

  getPackage: function (packageOrPackageName) {
    var self = this;
    var pkg = self.library.get(packageOrPackageName);
    if (! pkg) {
      console.error("Package not found: " + packageOrPackageName);
      process.exit(1);
    }
    return pkg;
  },

  // map a package's generated node_modules directory to the package
  // directory within the bundle
  bundleNodeModules: function (pkg) {
    var nodeModulesPath = path.join(pkg.npmDir(), 'node_modules');
    this.nodeModulesDirs[pkg.name] = nodeModulesPath;
  },

  // Sort the packages in dependency order, then, package by package,
  // write their resources into the bundle (which includes running the
  // JavaScript linker.)
  emitResources: function () {
    var self = this;

    // Copy their resources into the bundle in order
    _.each(self.slices, function (slice) {
      // ** Get the final resource list. It's the static resources
      // ** from the package plus the output of running the JavaScript
      // ** linker.

      slice.pkg.ensureCompiled();
      var resources = _.clone(slice.pkg.resources[slice.role][slice.where]);

      var isApp = ! slice.pkg.name;
      // Compute imports by merging the exports of all of the
      // packages we use. To be eligible to supply an import, a
      // slice must presently (a) be named (the app can't supply
      // exports, at least for now); (b) have the "use" role (you
      // can't import symbols from tests and such, primarily
      // because we don't have a good way to name non-"use" roles
      // in JavaScript.) Note that in the case of conflicting
      // symbols, later packages get precedence.
      var imports = {}; // map from symbol to supplying package name
      _.each(_.values(slice.pkg.uses[slice.role][slice.where]), function (otherPkgName){
        var otherPkg = self.getPackage(otherPkgName);
        if (otherPkg.name && ! slice.pkg.unordered[otherPkg.name]) {
          // make sure otherPkg.exports is valid
          otherPkg.ensureCompiled();
          _.each(otherPkg.exports.use[slice.where], function (symbol) {
            imports[symbol] = otherPkg.name;
          });
        }
      });

      // Phase 2 link
      var files = linker.link({
        imports: imports,
        useGlobalNamespace: isApp,
        prelinkFiles: slice.pkg.prelinkFiles[slice.role][slice.where],
        boundary: slice.pkg.boundary[slice.role][slice.where]
      });

      // Add each output as a resource
      _.each(files, function (file) {
        resources.push({
          type: "js",
          data: new Buffer(file.source, 'utf8'),
          servePath: file.servePath
        });
      });

      // ** Emit the resources
      _.each(resources, function (resource) {
        if (resource.type === "js") {
          self.files[slice.where][resource.servePath] = resource.data;
          self.js[slice.where].push(resource.servePath);
        } else if (resource.type === "css") {
          if (slice.where !== "client")
            // XXX might be nice to throw an error here, but then we'd
            // have to make it so that packages.js ignores css files
            // that appear in the server directories in an app tree

            // XXX XXX can't we easily do that in the css handler in
            // meteor.js?
            return;

          self.files[slice.where][resource.servePath] = resource.data;
          self.css.push(resource.servePath);
        } else if (resource.type === "static") {
          self.files[slice.where][resource.servePath] = resource.data;
          self.static[slice.where].push(resource.servePath);
        } else if (resource.type === "head" || resource.type === "body") {
          if (slice.where !== "client")
            throw new Error("HTML segments can only go to the client");
          self[resource.type].push(resource.data);
        } else {
          throw new Error("Unknown type " + resource.type);
        }
      });
    });
  },

  // Minify the bundle
  minify: function () {
    var self = this;

    var addFile = function (type, finalCode) {
      var contents = new Buffer(finalCode);
      var hash = sha1(contents);
      var name = '/' + hash + '.' + type;
      self.files.clientCacheable[name] = contents;
      self.manifest.push({
        path: 'static_cacheable' + name,
        where: 'client',
        type: type,
        cacheable: true,
        url: name,
        size: contents.length,
        hash: hash
      });
    };

    /// Javascript
    var codeParts = [];
    _.each(self.js.client, function (jsPath) {
      codeParts.push(self.files.client[jsPath].toString('utf8'));

      delete self.files.client[jsPath];
    });
    self.js.client = [];

    var combinedCode = codeParts.join('\n;\n');
    var finalCode = uglify.minify(
      combinedCode, {fromString: true, compress: {drop_debugger: false}}).code;

    addFile('js', finalCode);

    /// CSS
    var cssConcat = "";
    _.each(self.css, function (cssPath) {
      var cssData = self.files.client[cssPath];
      cssConcat = cssConcat + "\n" + cssData.toString('utf8');

      delete self.files.client[cssPath];
    });
    self.css = [];

    var finalCss = cleanCSS.process(cssConcat);

    addFile('css', finalCss);
  },

  _clientUrlsFor: function (type) {
    var self = this;
    return _.pluck(
      _.filter(self.manifest, function (resource) {
        return resource.where === 'client' && resource.type === type;
      }),
      'url'
    );
  },

  _generateAppHtml: function () {
    var self = this;

    // XXX we don't do content-based dependency watching for this file
    var template = fs.readFileSync(path.join(__dirname, "app.html.in"));
    var f = require('handlebars').compile(template.toString());
    return f({
      scripts: self._clientUrlsFor('js'),
      head_extra: self.head.join('\n'),
      body_extra: self.body.join('\n'),
      stylesheets: self._clientUrlsFor('css')
    });
  },

  // The extensions registered by the application package, if
  // any. Kind of a hack.
  _appExtensions: function () {
    var self = this;
    var ret = [];

    _.each(self.slices, function (slice) {
      if (! slice.pkg.name) {
        var exts = slice.pkg.registeredExtensions(slice.role, slice.where);
        ret = _.union(ret, exts);
      }
    });

    return ret;
  },

  _addDependency: function (filePath, hash, onlyIfExists) {
    var self = this;
    filePath = path.resolve(filePath);

    if (onlyIfExists && ! fs.existsSync(filePath))
      return;

    if (! hash)
      hash = sha1(fs.readFileSync(filePath));
    self.dependencyInfo.files[filePath] = hash;
  },

  // nodeModulesMode should be "skip", "symlink", or "copy"
  // computes self.dependencyInfo
  writeToDirectory: function (outputPath, projectDir, nodeModulesMode) {
    var self = this;
    var appJson = {};
    var isApp = files.is_app_dir(projectDir);

    self.dependencyInfo = {files: {}, directories: {}};

    if (isApp) {
      self._addDependency(path.join(projectDir, '.meteor', 'packages'));
      // Not sure why 'release' doesn't exist in a test run, but roll with it
      self._addDependency(path.join(projectDir, '.meteor', 'release'), null,
                          true);
    }

    // --- Set up build area ---

    // foo/bar => foo/.build.bar
    var buildPath = path.join(path.dirname(outputPath),
                              '.build.' + path.basename(outputPath));

    // XXX cleaner error handling. don't make the humans read an
    // exception (and, make suitable for use in automated systems)
    files.rm_recursive(buildPath);
    files.mkdir_p(buildPath, 0755);

    // --- Core runner code ---

    var serverPath = path.join(__dirname, 'server');
    var copied = files.cp_r(serverPath, path.join(buildPath, 'server'),
                            {ignore: ignoreFiles});
    _.each(copied, function (relPath) {
      self._addDependency(path.join(serverPath, relPath));
    });
    self.dependencyInfo.directories[serverPath] = {
      include: [/.?/],
      exclude: ignoreFiles
    };

    // --- Third party dependencies ---

    if (nodeModulesMode === "symlink")
      fs.symlinkSync(path.join(files.get_dev_bundle(), 'lib', 'node_modules'),
                     path.join(buildPath, 'server', 'node_modules'));
    else if (nodeModulesMode === "copy")
      files.cp_r(path.join(files.get_dev_bundle(), 'lib', 'node_modules'),
                 path.join(buildPath, 'server', 'node_modules'),
                 {ignore: ignoreFiles});
    else
      /* nodeModulesMode === "skip" */;

    fs.writeFileSync(
      path.join(buildPath, 'server', '.bundle_version.txt'),
      fs.readFileSync(
        path.join(files.get_dev_bundle(), '.bundle_version.txt')));

    // --- Static assets ---

    var addClientFileToManifest = function (filepath, contents, type, cacheable, url, hash) {
      if (! contents instanceof Buffer)
        throw new Error('contents must be a Buffer');
      var normalized = filepath.split(path.sep).join('/');
      if (normalized.charAt(0) === '/')
        normalized = normalized.substr(1);
      self.manifest.push({
        // path is normalized to use forward slashes
        path: (cacheable ? 'static_cacheable' : 'static') + '/' + normalized,
        where: 'client',
        type: type,
        cacheable: cacheable,
        url: url || '/' + normalized,
        // contents is a Buffer and so correctly gives us the size in bytes
        size: contents.length,
        hash: hash || sha1(contents)
      });
    };

    if (isApp) {
      var publicDir = path.join(projectDir, 'public');

      if (fs.existsSync(publicDir)) {
        var copied =
          files.cp_r(publicDir, path.join(buildPath, 'static'),
                     {ignore: ignoreFiles});

        _.each(copied, function (relPath) {
          var filepath = path.join(publicDir, relPath);
          var contents = fs.readFileSync(filepath);
          var hash = sha1(contents);

          self._addDependency(filepath, hash);
          addClientFileToManifest(relPath, contents, 'static', false,
                                  undefined, hash);
        });
      }

      self.dependencyInfo.directories[publicDir] = {
        include: [/.?/],
        exclude: ignoreFiles
      };
    }

    // Add cache busting query param if needed, and
    // add to manifest.
    var processClientCode = function (type, file) {
      var contents, url, hash;
      if (file in self.files.clientCacheable) {
        contents = self.files.clientCacheable[file];
        url = file;
      }
      else if (file in self.files.client) {
        // Client css and js becomes cacheable with the addition of the
        // cache busting query parameter.
        contents = self.files.client[file];
        delete self.files.client[file];
        self.files.clientCacheable[file] = contents;
        hash = sha1(contents);
        url = file + '?' + hash;
      }
      else
        throw new Error('unable to find file: ' + file);

      addClientFileToManifest(file, contents, type, true, url, hash);
    };

    _.each(self.js.client, function (file) { processClientCode('js',  file); });
    _.each(self.css,       function (file) { processClientCode('css', file); });

    // -- Client code --
    for (var relPath in self.files.client) {
      var fullPath = path.join(buildPath, 'static', relPath);
      files.mkdir_p(path.dirname(fullPath), 0755);
      fs.writeFileSync(fullPath, self.files.client[relPath]);
      addClientFileToManifest(relPath, self.files.client[relPath], 'static', false);
    }

    // -- Client cache forever code --
    for (var relPath in self.files.clientCacheable) {
      var fullPath = path.join(buildPath, 'static_cacheable', relPath);
      files.mkdir_p(path.dirname(fullPath), 0755);
      fs.writeFileSync(fullPath, self.files.clientCacheable[relPath]);
    }

    appJson.load = [];
    files.mkdir_p(path.join(buildPath, 'app'), 0755);
    for (var relPath in self.files.server) {
      var pathInBundle = path.join('app', relPath);
      var fullPath = path.join(buildPath, pathInBundle);
      files.mkdir_p(path.dirname(fullPath), 0755);
      fs.writeFileSync(fullPath, self.files.server[relPath]);
      appJson.load.push(pathInBundle);
    }

    // `node_modules` directories for packages
    _.each(self.nodeModulesDirs, function (sourceNodeModulesDir, packageName) {
      files.mkdir_p(path.join(buildPath, 'npm'));
      var buildModulesPath = path.join(buildPath, 'npm', packageName);
      // XXX we should consider supporting bundle time-only npm dependencies
      // which don't need to be pushed to the server.
      if (nodeModulesMode === 'symlink') {
        // if we symlink the dev_bundle, also symlink individual package
        // node_modules.
        fs.symlinkSync(sourceNodeModulesDir, buildModulesPath);
      } else {
        // otherwise, copy them. if we're skipping the dev_bundle
        // modules (eg for deploy) we still need the per-package
        // modules.
        // XXX this breaks arch-specific modules. oh well.
        files.cp_r(sourceNodeModulesDir, buildModulesPath);
      }
    });

    var appHtml = self._generateAppHtml();
    fs.writeFileSync(path.join(buildPath, 'app.html'), appHtml);
    self.manifest.push({
      path: 'app.html',
      where: 'internal',
      hash: sha1(appHtml)
    });
    self._addDependency(path.join(__dirname, 'app.html.in'));

    // --- Documentation, and running from the command line ---

    fs.writeFileSync(path.join(buildPath, 'main.js'),
"require('./server/server.js');\n");

    fs.writeFileSync(path.join(buildPath, 'README'),
"This is a Meteor application bundle. It has only one dependency,\n" +
"node.js (with the 'fibers' package). To run the application:\n" +
"\n" +
"  $ npm install fibers@1.0.0\n" +
"  $ export MONGO_URL='mongodb://user:password@host:port/databasename'\n" +
"  $ export ROOT_URL='http://example.com'\n" +
"  $ export MAIL_URL='smtp://user:password@mailhost:port/'\n" +
"  $ node main.js\n" +
"\n" +
"Use the PORT environment variable to set the port where the\n" +
"application will listen. The default is 80, but that will require\n" +
"root on most systems.\n" +
"\n" +
"Find out more about Meteor at meteor.com.\n");

    // --- Source file dependencies ---

    _.each(_.values(self.slices), function (slice) {
      _.extend(self.dependencyInfo.files, slice.pkg.dependencyFileShas);
    });

    if (isApp) {
      // Include files in the app that match any file extension
      // handled by any package that the app uses
      self.dependencyInfo.directories[path.resolve(projectDir)] = {
        include: _.map(self._appExtensions(), function (ext) {
          return new RegExp('\\.' + ext.slice(1) + "$");
        }),
        exclude: ignoreFiles
      };
      // Exclude the packages directory in an app, since packages
      // explicitly call out the files they use
      self.dependencyInfo.directories[path.resolve(projectDir, 'packages')] = {
        exclude: [/.?/]
      };
      // Exclude .meteor/local and everything under it
      self.dependencyInfo.directories[
        path.resolve(projectDir, '.meteor', 'local')] = { exclude: [/.?/] };
    }

    // --- Metadata ---

    appJson.manifest = self.manifest;

    if (self.releaseStamp && self.releaseStamp !== 'none')
      appJson.release = self.releaseStamp;

    fs.writeFileSync(path.join(buildPath, 'app.json'),
                     JSON.stringify(appJson, null, 2));

    // --- Move into place ---

    // XXX cleaner error handling (no exceptions)
    files.rm_recursive(outputPath);
    fs.renameSync(buildPath, outputPath);
  }

});

///////////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////////

/**
 * Take the Meteor app in projectDir, and compile it into a bundle at
 * outputPath. outputPath will be created if it doesn't exist (it
 * will be a directory), and removed if it does exist. The release
 * version is *not* read from the app's .meteor/release file. Instead,
 * it must be passed in as an option.
 *
 * Returns an object with keys:
 * - errors: An array of strings, or falsy if bundling succeeded.
 * - dependencyInfo: Information about files and paths that were
 *   inputs into the bundle and that we may wish to monitor for
 *   changes when developing interactively. It has two keys, 'files'
 *   and 'directories', in the format expected by watch.Watcher.
 *
 * On failure ('errors' is truthy), no bundle will be output (in fact,
 * outputPath will have been removed if it existed.)
 *
 * options include:
 * - minify : minify the CSS and JS assets
 *
 * - nodeModulesMode : decide on how to create the bundle's
 *   node_modules directory. one of:
 *     'skip' : don't create node_modules. used by `meteor deploy`, since
 *              our production servers already have all of the node modules
 *     'copy' : copy from a prebuilt local installation. used by
 *              `meteor bundle`
 *     'symlink' : symlink from a prebuild local installation. used
 *                 by `meteor run`
 *
 * - testPackages : array of package objects or package names whose
 *   tests should be included in this bundle
 *
 * - releaseStamp : The Meteor release version to use. This is *ONLY*
 *                  used as a stamp (eg Meteor.release). The package
 *                  search path is configured with 'library'.
 *
 * - library : Package library to use to fetch any required
 *   packages. NOTE: if there's an appDir here, it's used for package
 *   searching but it is NOT the appDir that we bundle!  So for
 *   "meteor test-packages" in an app, appDir is the test-runner-app
 *   but library.appDir is the app the user is in.
 */
exports.bundle = function (appDir, outputPath, options) {
  if (!options)
    throw new Error("Must pass options");
  if (!options.nodeModulesMode)
    throw new Error("Must pass options.nodeModulesMode");
  if (!options.library)
    throw new Error("Must pass options.library");
  if (!options.releaseStamp)
    throw new Error("Must pass options.releaseStamp or 'none'");

  var library = options.library;

  try {
    // Create a bundle and set up package search path
    var bundle = new Bundle({
      releaseStamp: options.releaseStamp,
      library: library
    });

    // Create a Package object that represents the app
    var app = library.getForApp(appDir, ignoreFiles);

    // Populate the list of slices to load
    bundle.determineLoadOrder({
      use: {client: [app], server: [app]},
      test: {client: options.testPackages || [],
             server: options.testPackages || []}
    });

    // Process npm modules
    bundle.prepNodeModules();

    // Link JavaScript, put resources in load order, and copy them to
    // the bundle
    bundle.emitResources();

    // Minify, if requested
    if (options.minify)
      bundle.minify();

    // Write to disk
    bundle.writeToDirectory(outputPath, appDir, options.nodeModulesMode);

    return {
      errors: false,
      dependencyInfo: bundle.dependencyInfo
    };
  } catch (err) {
    files.rm_recursive(outputPath);
    return {
      errors: ["Exception while bundling application:\n" + (err.stack || err)]
    };
  }
};
