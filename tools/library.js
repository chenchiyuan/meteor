var path = require('path');
var _ = require('underscore');
var files = require('./files.js');
var packages = require('./packages.js');
var warehouse = require('./warehouse.js');
var bundler = require('./bundler.js');
var fs = require('fs');

// Under the hood, packages in the library (/package/foo), and user
// applications, are both Packages -- they are just represented
// differently on disk.

// Options:
//  - `releaseManifest` (a parsed release manifest)
//  - `appDir` (directory which may contain a `packages` subdir)
// XXX XXX as implemented, it reads the environment and the current
// directory. It shouldn't do that. Those should ultimately be ctor
// arguments or something.
var Library = function (options) {
  var self = this;
  options = options || {};

  self.loadedPackages = {};

  self.preloadedPackages = {};
  self.releaseManifest = options.releaseManifest;
  self.appDir = options.appDir;
};

_.extend(Library.prototype, {
  // Temporarily add a package to the library (or override a package
  // that actually exists in the library.) `packageName` is the name
  // to use for the package and `packageDir` is the directory that
  // contains its source.
  preload: function (packageName, packageDir) {
    var self = this;
    var pkg = new packages.Package(self);
    pkg.initFromPackageDir(name, packageDir);
    self.preloadedPackages[packageName] = pkg;
  },

  // force reload of all packages (does not affect preloaded packages:
  // they are still in effect and are not reloaded)
  flush: function () {
    var self = this;
    self.loadedPackages = {};
  },

  // get a package by name. also maps package objects to
  // themselves. throw an exception if the package can't be loaded.
  // load order is:
  // - APP_DIR/packages
  // - PACKAGE_DIRS
  // - METEOR_DIR/packages (if in a git checkout)
  // - warehouse (if options.releaseManifest passed)
  get: function (name) {
    var self = this;
    if (name instanceof packages.Package)
      return name;

    // Packages overridden with preload()
    if (name in self.preloadedPackages)
      return self.preloadedPackages[name];

    // Packages cached from previous calls
    if (name in self.loadedPackages)
      return self.loadedPackages[name];

    // Try local packages:
    // - APP/packages
    // - GITCHECKOUTOFMETEOR/packages
    // - $PACKAGE_DIRS (colon-separated)
    var pkg = new packages.Package(self);
    var packageDir = self.directoryForLocalPackage(name);
    if (packageDir) {
      pkg.initFromPackageDir(name, packageDir);
      return (self.loadedPackages[name] = pkg);
    }

    // Try the release
    var version = self.releaseManifest && self.releaseManifest.packages[name];
    if (version) {
      pkg.initFromPackageDir(name, path.join(warehouse.getWarehouseDir(),
                                             'packages', name, version));
      pkg.inWarehouse = true;
      return (self.loadedPackages[name] = pkg);
    }

    throw new Error("Package not available: " + name);
  },

  // get a package that represents an app. (ignore_files is optional
  // and if given, it should be an array of regexps for filenames to
  // ignore when scanning for source files.)
  getForApp: function (app_dir, ignore_files) {
    var self = this;
    var pkg = new packages.Package(self);
    pkg.initFromAppDir(app_dir, ignore_files || []);
    return pkg;
  },

  // get all packages available. options are appDir and releaseManifest.
  //
  // returns {Object} maps name to Package
  list: function () {
    var self = this;
    var list = {};

    _.each(self._localPackageDirs(), function (dir) {
      _.each(fs.readdirSync(dir), function (name) {
        if (files.is_package_dir(path.join(dir, name))) {
          if (!list[name]) // earlier directories get precedent
            list[name] = self.get(name);
        }
      });
    });

    if (self.releaseManifest) {
      _.each(self.releaseManifest.packages, function(version, name) {
        // don't even look for packages if they've already been
        // overridden (though this `if` isn't necessary for
        // correctness, since `packages.get` looks for packages in the
        // override directories first anyways)
        if (!list[name])
          list[name] = self.get(name);
      });
    }

    return list;
  },

  // for a package that exists in localPackageDirs, find the directory
  // in which it exists.
  // XXX does this need to be absolute?
  directoryForLocalPackage: function (name) {
    var self = this;
    var searchDirs = self._localPackageDirs();
    for (var i = 0; i < searchDirs.length; ++i) {
      var packageDir = path.join(searchDirs[i], name);
      if (fs.existsSync(path.join(packageDir, 'package.js')))
        return packageDir;
    }
    return undefined;
  },

  _localPackageDirs: function () {
    var self = this;
    var packageDirs = [];

    // If we're running from an app (as opposed to a global-level "meteor
    // test-packages"), use app packages.
    if (self.appDir)
      packageDirs.push(path.join(self.appDir, 'packages'));

    // Next, search $PACKAGE_DIRS.
    if (process.env.PACKAGE_DIRS)
      packageDirs.push.apply(packageDirs, process.env.PACKAGE_DIRS.split(':'));

    // If we're running out of a git checkout of meteor, use the packages from
    // the git tree.
    if (!files.usesWarehouse())
      packageDirs.push(path.join(files.getCurrentToolsDir(), 'packages'));

    // Only return directories that exist.
    return _.filter(packageDirs, function (dir) {
      try {
        // use stat rather than lstat since symlink to dir is OK
        var stats = fs.statSync(dir);
      } catch (e) {
        return false;
      }
      return stats.isDirectory();
    });
  }

});

var library = exports;
_.extend(exports, {

  Library: Library,

  // returns a pretty list suitable for showing to the user. input is
  // a list of package objects, each of which must have a name (not be
  // an application package.)
  format_list: function (pkgs) {
    var longest = '';
    _.each(pkgs, function (pkg) {
      if (pkg.name.length > longest.length)
        longest = pkg.name;
    });
    var pad = longest.replace(/./g, ' ');
    // it'd be nice to read the actual terminal width, but I tried
    // several methods and none of them work (COLUMNS isn't set in
    // node's environment; `tput cols` returns a constant 80.) maybe
    // node is doing something weird with ptys.
    var width = 80;

    var out = '';
    _.each(pkgs, function (pkg) {
      if (pkg.metadata.internal)
        return;
      var name = pkg.name + pad.substr(pkg.name.length);
      var summary = pkg.metadata.summary || 'No description';
      out += (name + "  " +
              summary.substr(0, width - 2 - pad.length) + "\n");
    });

    return out;
  }
});