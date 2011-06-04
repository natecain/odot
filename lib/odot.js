/*global require, exports, process, console */
/*jslint nomen: false */

var fs = require('fs'),
    path = require('path'),
    rep = require('repl'),
    Script = process.binding('evals').Script,
    db = {},
    files = {},
    prototypes = {},
    dbFile = 'o.json',
    context;

function save() {
    var dbJSON;
    
    dbJSON = JSON.stringify(db, null, 1); // Format for diff

    // Synchronous for safety - when called during repl exit synchronous
    // is necessary to complete write before process exit. Could make
    // asynchronous when save() command is used inside repl since dbJSON
    // will not change, but need to explore what would happen if repl exit
    // and sync write happened while an async save operation was going on.
    fs.writeFileSync(dbFile, dbJSON); 
}

function loadDB() {
    var dbJSON, dbLoaded, i;

    // Because we cannot change the context db reference from methods
    // executed in REPL itself (like reset()), we must remove and change
    // the references on the db object to which the context has a reference.
    // Also effective for non-repl use where consuming code has a reference
    // to the database.
    for (i in db) {
        if (db.hasOwnProperty(i)) {
            delete(db[i]);
        }
    }

    // Running this after the above should allow old db graph to be
    // garbage collected if needed to complete this.
    // 
    // This blocks so that other logic does not get executed until database is
    // fully loaded and so that reset() stops all other execution until
    // database is fully reloaded.
    if (path.existsSync(dbFile)) {
        dbJSON = fs.readFileSync(dbFile, 'utf8'); 
        dbLoaded = JSON.parse(dbJSON);

        for (i in dbLoaded) {
            if (dbLoaded.hasOwnProperty(i)) {
                db[i] = dbLoaded[i];
            }
        }
    }
}

// Creates a constructor in the database for objecs of a mapped type.
function constructor(key) {
    var proto = prototypes[key], newEntry,
        construct = function (id, entry) {
            newEntry = Object.create(entry || proto);
            if (id) {
                newEntry.id = id;
                db[key][id] = newEntry;
            }
            if (entry) {
                newEntry.iproto = entry.id;
            }
            return newEntry;
        };
    return construct;
}

function map(key, file) {
    var indexScript = process.argv[1],
        dir = path.dirname(indexScript),
        absolutePath = path.join(dir, file);
    files[key] = absolutePath;
}

function prototizeEntries(entries, constructor) {
    var i, construct, entry, proto, protoEntry; 
    for (i in entries) {
        if (entries.hasOwnProperty(i)) {

            // Transferring all members of stored entry to a newly constructed
            // entry because the entry constructed from JSON parse does not have
            // the entry prototype.
            entry = entries[i];
            proto = entries[entry.iproto];
            protoEntry = constructor(i, proto);  // Replaces original in db
            for (i in entry) {
                if (entry.hasOwnProperty(i)) {
                    protoEntry[i] = entry[i];
                }
            }
        }
    }
}

function protoAdd(obj) {
    var key = obj.key,
        iname = 'i' + key;

    if (!this[iname]) {
        this[iname] = [];
    }

    this[iname].push(obj.id);
}

function protoRemove(obj) {
    var key = obj.key,
        iname = 'i' + key,
        id = obj.id,
        ids = this[iname],
        i, length, index;

    if (ids) {
        for (i = 0, length = ids.length; i < length; i += 1) {
            if (ids[i] === id) {
                ids.splice(i, 1);
            }
        }
    }
}

function prototize(key, file) {
    var capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1),
        prototyped = db[capitalizedKey] !== undefined, // If constructor
        js = fs.readFileSync(file, 'utf8'), // Block until all prototized
        i, entries, proto, construct;
        
    // Create or update the entry prototype from code file
    proto = prototypes[key] = prototypes[key] || {};

    // Clean up prototype in case new code drops old vars or methods
    for (i in proto) {
        if (proto.hasOwnProperty(i)) {
            delete(proto[i]);
        }
    }

    proto.require = require; // All mapped code is assumed trusted
    proto.console = console;
    proto.db = db;

    proto.key = key;

    // Convenience method for adding calculable properties to a prototype
    proto.calculable =  function (name, calculator) {
        var iname = 'i' + name, ival;
        proto.__defineGetter__(name, function () {
            var ival = this[iname];
            if (ival) {
                return ival;
            } else {
                return calculator.call(this);
            }
        });

        proto.__defineSetter__(name, function (val) {
            if (val !== null) {
                this[iname] = val;
            } else {
                delete this[iname];
            }
        });
    };

    // Convenience method for indicating some members should not be persisted 
    proto.ephemeral = function (name) {
        if (!proto.ephemera) {
            proto.ephemera = [];
        }
        proto.ephemera.push(name);
    };

    proto.toJSON = function () {
        var i, length, name;
        if (proto.ephemera) {
            for (i = 0, length = proto.ephemera.length; i < length; i += 1) {
                name = proto.ephemera[i];
                delete this[name];
            }
        }
        return this;
    };

    // Convenience method for adding a relationship to another db object
    proto.one =  function (name) {
        var iname = 'i' + name, ival;
        proto.__defineGetter__(name, function () {
            var ival = this[iname];
            if (ival) {
                return db[name][ival];
            } else {
                return null;
            }
        });

        proto.__defineSetter__(name, function (val) {
            if (val !== null) {
                this[iname] = val.id;
            } else {
                delete this[iname];
            }
        });
    };

    // Convenience method for adding a relationship to many other db objects
    proto.many = function (name) {
        var iname = 'i' + name, ival;

        proto.__defineGetter__(name, function () {
            var ids = this[iname],
                objs = [],
                i, length;
            for (i = 0, length = ids.length; i < length; i += 1) {
                objs.push(db[name][ids[i]]);
            }
            return objs;
        });

        proto.__defineSetter__(name, function (val) {
            var i, length, iarray;
            if (val !== null) {
                iarray = [];
                for (i = 0, length = val.length; i < length; i += 1) {
                    iarray.push(val[i].id);
                }
                this[iname] = iarray;
            } else {
                delete this[iname];
            }
        });
    };

    // Add methods for adding and removing object to object relationships
    proto.add = protoAdd;
    proto.remove = protoRemove;

    Script.runInNewContext(js, proto, file);

    // Initialize entries obect literal in case initializing database
    entries = db[key] = db[key] || {};

    // Create entry constructor
    construct = db[capitalizedKey] = constructor(key);

    // Attach all entries to prototype if loading from saved db 
    if (!prototyped) {
        prototizeEntries(entries, construct);        
    }
}

function loadCode() {
    var i;
    for (i in files) {
        if (files.hasOwnProperty(i)) {
            prototize(i, files[i]); 
        }
    }
}

function load(saveOnExit) {
    loadDB();
    loadCode();

    if (saveOnExit) {
        process.addListener('exit', function () {
            save();
        });
    }

    return db;
}

function reset() {
    load(false);
}

// Map in new entry types after database started
function liveMap(key, file) {
    map(key, file);
    prototize(key, files[key]); 
}

function repl(file, refs) {
    var i;
    dbFile = file || dbFile;
    load(true);
    context = rep.start().context;

    if (refs) {
        for (i in refs) {
            if (refs.hasOwnProperty(i)) {
                context[i] = refs[i];
            }
        }
    }

    context.o = db;
    context.save = save;
    context.reset = reset;
    context.recode = context.rc = loadCode;
    context.liveMap = liveMap;
    context.context = context;
}


exports.map = map;
exports.load = load;
exports.repl = repl;
exports.liveMap = liveMap;
exports.save = save;
exports.reset = reset;
exports.recode = exports.rc = loadCode;
