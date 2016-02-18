'use strict';

var child_process = require('child_process');
var fs = require('./file.js');
var path = require('path');
var req = require('lazreq')({
  deasync: 'deasync',
  ipfsAPI: 'ipfs-api',
  os: 'os',
  Workspace: './workspace.js'
});

module.exports = class Dependency {
  constructor (path, version, name) {
    this.setName(name || '');
    this.path = path || '';
    this.version = version || '';
    this.packagesDirectory = 'dapple_packages';
    this.installedAt = '';

    if (this.hasGitPath() && !version) {
      throw new Error('Git paths must include an exact commit hash!');
    }
  }

  static fromDependencyString (path, name) {
    let gitPathRegex = /^(.+.git)(?:@([a-z0-9]+))$/i;
    if (gitPathRegex.test(path)) {
      let pathPieces = gitPathRegex.exec(path);
      let version = pathPieces[2];
      path = pathPieces[1];
      return new Dependency(path, version, name);
    }

    let pathRegex = /^([^@#]+)?(?:@(.+)?)?$/;
    let pathPieces = pathRegex.exec(path);
    let version = pathPieces[2];
    path = pathPieces[1];

    if (/^@?(ipfs:\/\/)?Qm[A-Za-z0-9]+$/i.test(version || path)) {
      if (!name) {
        name = version ? path : '';
      }
      version = (version || path).replace(/^@?ipfs:\/\//i, '');
      path = 'ipfs://' + version;
    }
    return new Dependency(path, version, name);
  }

  install () {
    if (this.getName()) {
      this._throwIfInstalled();
    }

    try {
      fs.accessSync(this.packagesDirectory, fs.W_OK);
    } catch (e) {
      try {
        fs.mkdirSync(this.packagesDirectory);
      } catch (e) {
        throw new Error('Could not access or create ' +
                        this.packagesDirectory + ': ' + e);
      }
    }

    if (this.getName()) {
      let installedAt = path.join(this.packagesDirectory, this.getName());
      this.pull(installedAt);
      this.installedAt = installedAt;
      return;
    }

    let tmpDir = this._getTmpDir();
    this.pull(tmpDir);
    this.setName(req.Workspace.atPackageRoot(tmpDir).dappfile.name);

    let installedAt = path.join(this.packagesDirectory, this.getName());
    fs.copySync(tmpDir, installedAt);
    this.installedAt = installedAt;

    try {
      fs.removeSync(tmpDir);
    } catch (e) {
      throw new Error(this.getName() + ' installed at ' + installedAt +
                      ', but cleanup failed. Please manually delete ' + tmpDir);
    }
  }

  hasGitPath () {
    return /\.git$/i.test(this.path);
  }

  hasIPFSPath () {
    return /^ipfs:\/\/[A-Za-z0-9]+$/i.test(this.path);
  }

  hasVersion () {
    return this.version !== '';
  }

  getVersion () {
    return this.version;
  }

  getName () {
    return this.name;
  }

  setName (name) {
    this.name = name;
  }

  getPath () {
    return this.path;
  }

  toString () {
    return this.getPath() + this.getVersion();
  }

  _getTmpDir () {
    if (!this._tmpDir) {
      this._tmpDir = path.join(req.os.tmpdir(), 'dapple', 'packages',
                               String(Math.random()).slice(2));
      fs.emptyDirSync(this._tmpDir);
    }
    return this._tmpDir;
  }

  pull (destination) {
    if (this.hasGitPath()) {
      this._pullGit(destination);
    } else if (this.hasIPFSPath()) {
      this._pullIPFS(destination);
    } else {
      throw new Error('Could not make sense of "' + this.getPath() + '"');
    }
  }

  _pullGit (target) {
    if (!this.hasVersion()) {
      throw new Error('Git paths must include an exact commit hash!');
    }

    let commit = this.getVersion().replace(/^@/, '');

    if (!/^[a-f0-9]+$/i.test(commit)) {
      throw new Error('Invalid commit hash: ' + commit);
    }

    child_process.execSync('git clone ' + this.getPath() + ' ' + target);
    child_process.execSync('git reset --hard ' + commit, {cwd: target});
    child_process.execSync('git submodule init', {cwd: target});
    child_process.execSync('git submodule update', {cwd: target});
  }

  _pullIPFS (target) {
    let settings = req.Workspace.getDappleRC().environment('live').ipfs;
    let ipfs = req.ipfsAPI(settings.host, settings.port);
    let rootHash = this.getPath().replace(/^ipfs:\/\//i, '');
    let ls = req.deasync(ipfs.ls);
    let cat = req.deasync(ipfs.cat);
    let types = { dir: 1, file: 2 };

    // Test connection before proceeding.
    try {
      ls(rootHash);
    } catch (e) {
      throw new Error('Unable to retrieve directory from IPFS! ' +
                      'Please make sure your IPFS connection settings ' +
                      'in ~/.dapplerc are correct and that you have ' +
                      'supplied the correct IPFS hash.');
    }

    function pullIPFS (hash, dest, type) {
      if (type === types.dir) {
        fs.ensureDirSync(dest);
        let links = ls(hash).Objects[0].Links;

        for (let i = 0; i < links.length; i += 1) {
          pullIPFS(links[i].Hash,
                   path.join(dest, links[i].Name),
                   links[i].Type);
        }
      } else if (type === types.file) {
        fs.writeFileSync(dest, cat(hash).read());
      } else {
        throw new Error('Unknown IPFS type "' + type + '" at ' +
                        hash + ' while pulling ' + rootHash);
      }
    }

    pullIPFS(rootHash, target, types.dir);
  }

  _throwIfInstalled () {
    let target = path.join(this.packagesDirectory, this.getName());
    let alreadyInstalled = false;

    try {
      fs.accessSync(target, fs.R_OK);
      alreadyInstalled = true;
    } catch (e) {}

    if (alreadyInstalled) {
      throw new Error(this.getName() + ' is already installed.');
    }
  }
};
