/*global require, exports, process, console */
/*jslint nomen: false */

// odot - a persistent, interactive object space with code reloading.
//
// Core concepts:
//   - `db`         : the in-memory database object; a plain object whose keys
//                    are collection names and whose values are collections of
//                    entries (also plain objects).
//   - `files`      : maps collection keys to the absolute path of each
//                    collection's prototype script.
//   - `prototypes` : maps collection keys to the shared prototype object that
//                    all entries of that collection inherit from.
//   - `dbFile`     : path to the JSON file used to persist the database state
//                    (defaults to 'o.json' in the working directory).
//   - `context`    : the REPL evaluation context, populated with helpers such
//                    as save(), reset(), and recode() so they are available
//                    directly at the prompt.
//   - `loaded`     : flag indicating whether load() has been called; used to
//                    decide whether a map() call should immediately prototize.

var fs = require('fs'),
    path = require('path'),
    rep = require('repl'),
    Script = process.binding('evals').Script,
    db = {},
    files = {},
    prototypes = {},
    dbFile = 'o.json',
    context,
    loaded = false;

// Persists the current in-memory database state to the JSON file on disk.
// Uses synchronous I/O so that the write completes even when called from the
// 'exit' event handler (asynchronous writes would not finish before the
// process terminates).
function save() {
    var dbJSON;
    
    dbJSON = JSON.stringify(db, null, 1); // Format with indentation for readability and diff-friendliness

    // Synchronous for safety - when called during repl exit synchronous
    // is necessary to complete write before process exit. Could make
    // asynchronous when save() command is used inside repl since dbJSON
    // will not change, but need to explore what would happen if repl exit
    // and sync write happened while an async save operation was going on.
    fs.writeFileSync(dbFile, dbJSON); 
}

// Loads (or reloads) the raw JSON database from disk into the shared `db`
// object in-place, preserving the same object reference so that the REPL
// context and any other code that holds a reference to `db` automatically
// sees the refreshed state.
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

// Returns a factory function ("constructor") for a given collection key.
// The returned function creates new entry objects that inherit from the
// collection's prototype.  Optionally accepts a second `entry` argument to
// use an existing entry as the prototype (enabling object-as-prototype
// inheritance within a collection).
//
// @param  {string}   key  - Collection name (e.g. 'train').
// @return {Function}      - Factory function with signature (id, entry):
//                             @param {string} id    - Unique id for the new entry.
//                             @param {Object} entry - Optional existing entry to use as prototype.
//                             @return {Object}      - Newly constructed entry.
function constructor(key) {
    var proto = prototypes[key], newEntry,
        construct = function (id, entry) {
            // Create the new entry inheriting from either a specific entry
            // (object-as-prototype) or the shared collection prototype.
            newEntry = Object.create(entry || proto);
            if (id) {
                newEntry.id = id;
                db[key][id] = newEntry; // Register in the collection map
            }
            if (entry) {
                // Record the id of the prototype entry so the relationship
                // can be re-established when the database is reloaded.
                newEntry.iproto = entry.id;
            }
            return newEntry;
        };
    return construct;
}

// Re-attaches the correct prototype chain to all entries in a collection
// after they have been deserialized from plain JSON (which strips prototype
// links).  Each entry's `iproto` field, if set, points to the id of another
// entry that should serve as its prototype.
//
// @param {Object}   entries     - The raw collection object from the parsed JSON.
// @param {Function} constructor - The factory returned by constructor(key).
function prototizeEntries(entries, constructor) {
    var i, construct, entry, proto, protoEntry; 
    for (i in entries) {
        if (entries.hasOwnProperty(i)) {

            // Transferring all members of stored entry to a newly constructed
            // entry because the entry constructed from JSON parse does not have
            // the entry prototype.
            entry = entries[i];
            proto = entries[entry.iproto]; // Look up the prototype entry by id
            protoEntry = constructor(i, proto);  // Replaces original in db
            for (i in entry) {
                if (entry.hasOwnProperty(i)) {
                    protoEntry[i] = entry[i]; // Copy all own properties to the new entry
                }
            }
        }
    }
}

// Adds an object to this entry's "many" relation for a given collection.
// Internally stores only the object's id to keep the persisted data lean.
// Called as `entry.add(relatedObj)`.
//
// @param {Object} obj - The related entry to add (must have `key` and `id` properties).
function protoAdd(obj) {
    var key = obj.key,
        iname = 'i' + key; // Internal storage property name (e.g. 'itrain')

    if (!this[iname]) {
        this[iname] = []; // Lazily initialize the ids array
    }

    this[iname].push(obj.id);
}

// Removes an object from this entry's "many" relation for a given collection.
// Called as `entry.remove(relatedObj)`.
//
// @param {Object} obj - The related entry to remove (must have `key` and `id` properties).
function protoRemove(obj) {
    var key = obj.key,
        iname = 'i' + key, // Internal storage property name (e.g. 'itrain')
        id = obj.id,
        ids = this[iname],
        i, length, index;

    if (ids) {
        for (i = 0, length = ids.length; i < length; i += 1) {
            if (ids[i] === id) {
                ids.splice(i, 1); // Remove the matching id in-place
            }
        }
    }
}

// Reads, evaluates, and installs a prototype script for a collection.
// This is the core of odot's "live coding" feature: calling prototize()
// again with updated source replaces the prototype's properties and
// methods in-place, so all existing entries immediately reflect the changes.
//
// Steps performed:
//   1. Read the prototype JS file from disk.
//   2. Reset the existing prototype object (to drop stale properties).
//   3. Inject built-in helpers (one, many, ephemeral, calculable, add, remove).
//   4. Execute the prototype script inside the prototype object as its context.
//   5. Ensure the collection's entry map and constructor exist in `db`.
//   6. On first load, walk all deserialized entries and restore their prototype links.
//
// @param {string} key  - Collection name (e.g. 'train').
// @param {string} file - Absolute path to the prototype script.
function prototize(key, file) {
    var capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1),
        prototyped = db[capitalizedKey] !== undefined, // True if constructor already registered
        js = fs.readFileSync(file, 'utf8'), // Read prototype script synchronously
        i, entries, proto, construct;
        
    // Create or update the entry prototype from code file
    proto = prototypes[key] = prototypes[key] || {};

    // Clean up prototype in case new code drops old vars or methods
    for (i in proto) {
        if (proto.hasOwnProperty(i)) {
            delete(proto[i]);
        }
    }

    // Expose trusted globals to the prototype script
    proto.require = require; // All mapped code is assumed trusted
    proto.console = console;
    proto.db = db;

    proto.key = key; // Needed by protoAdd / protoRemove to identify the collection

    // Convenience method for adding calculable properties to a prototype.
    // A calculable property is one that can be set directly OR derived from
    // other properties via a calculator function when no direct value is present.
    // The direct value is stored under an internal 'i<name>' property so that
    // it can be persisted without conflicting with the getter/setter pair.
    proto.calculable =  function (name, calculator) {
        var iname = 'i' + name, ival;
        proto.__defineGetter__(name, function () {
            var ival = this[iname];
            if (ival) {
                return ival; // Return directly-set value if present
            } else {
                return calculator.call(this); // Otherwise derive the value
            }
        });

        proto.__defineSetter__(name, function (val) {
            if (val !== null) {
                this[iname] = val; // Store the directly-set value
            } else {
                delete this[iname]; // Setting to null clears the direct value so the calculator takes over
            }
        });
    };

    // Convenience method for indicating some members should not be persisted.
    // Ephemeral properties exist only for the lifetime of the current process;
    // they are stripped from the object before JSON serialization via toJSON().
    proto.ephemeral = function (name) {
        if (!proto.ephemera) {
            proto.ephemera = [];
        }
        proto.ephemera.push(name);
    };

    // Called automatically by JSON.stringify to remove ephemeral properties
    // from an entry before it is serialized and written to the database file.
    proto.toJSON = function () {
        var i, length, name;
        if (proto.ephemera) {
            for (i = 0, length = proto.ephemera.length; i < length; i += 1) {
                name = proto.ephemera[i];
                delete this[name]; // Drop the ephemeral value so it is not persisted
            }
        }
        return this;
    };

    // Convenience method for declaring a one-to-one relationship to objects
    // of another collection.  Internally persists only the related object's id
    // (under 'i<name>') and resolves it back to a live object on read.
    proto.one =  function (name) {
        var iname = 'i' + name, ival;
        proto.__defineGetter__(name, function () {
            var ival = this[iname];
            if (ival) {
                return db[name][ival]; // Resolve stored id to a live object
            } else {
                return null;
            }
        });

        proto.__defineSetter__(name, function (val) {
            if (val !== null) {
                this[iname] = val.id; // Persist only the id, not the full object
            } else {
                delete this[iname]; // Setting to null removes the relationship
            }
        });
    };

    // Convenience method for declaring a one-to-many relationship to objects
    // of another collection.  Internally persists an array of ids (under
    // 'i<name>') and resolves them to live objects on read.
    proto.many = function (name) {
        var iname = 'i' + name, ival;

        proto.__defineGetter__(name, function () {
            // Build and return a fresh array of live objects each time so that
            // mutating the returned array does not affect the stored ids.
            var ids = this[iname],
                objs = [],
                i, length;
            for (i = 0, length = ids.length; i < length; i += 1) {
                objs.push(db[name][ids[i]]); // Resolve each stored id to a live object
            }
            return objs;
        });

        proto.__defineSetter__(name, function (val) {
            var i, length, iarray;
            if (val !== null) {
                // Persist an array of ids derived from the provided object array
                iarray = [];
                for (i = 0, length = val.length; i < length; i += 1) {
                    iarray.push(val[i].id);
                }
                this[iname] = iarray;
            } else {
                delete this[iname]; // Setting to null clears all relationships
            }
        });
    };

    // Attach shared add/remove helpers so prototype scripts can use them
    proto.add = protoAdd;
    proto.remove = protoRemove;

    // Execute the prototype script with `proto` as its global context.
    // Variables and functions declared in the script become own properties of
    // `proto` and are therefore inherited by all entries of this collection.
    Script.runInNewContext(js, proto, file);

    // Initialize entries object literal in case initializing database
    entries = db[key] = db[key] || {};

    // Create entry constructor (also registered as db[CapitalizedKey] for
    // use in the REPL, e.g. o.Train('express'))
    construct = db[capitalizedKey] = constructor(key);

    // On first load, re-attach prototypes to entries that were deserialized
    // from JSON (which strips prototype links).  Skip on recode() calls since
    // the entries already have the correct prototype.
    if (!prototyped) {
        prototizeEntries(entries, construct);        
    }
}

// Registers a collection with its prototype script.  The file path is
// resolved relative to the directory containing the entry-point script
// (process.argv[1]) so that the database script can use relative paths.
// If the database has already been loaded (loaded === true), the collection
// is prototized immediately; otherwise it will be processed during load().
//
// @param {string} key  - Collection name (e.g. 'train').
// @param {string} file - Path to the prototype script, relative to the DB script.
function map(key, file) {
    var indexScript = process.argv[1],
        dir = path.dirname(indexScript),
        absolutePath = path.join(dir, file);
    files[key] = absolutePath;
    if (loaded) {
        prototize(key, absolutePath); // Immediately prototize if already loaded (live mapping)
    }
}

// (Re-)loads the prototype code for all registered collections.
// Used internally during load() and exposed as recode()/rc() in the REPL so
// that prototype script edits can be hot-reloaded without restarting the
// process.
function loadCode() {
    var i;
    for (i in files) {
        if (files.hasOwnProperty(i)) {
            prototize(i, files[i]); 
        }
    }
}

// Initializes the database: loads persisted data from disk, then loads
// prototype code for all registered collections.  If saveOnExit is true,
// registers a process 'exit' listener so the database is automatically
// persisted when the process terminates (used by repl()).
//
// @param  {boolean} saveOnExit - When true, persist the database on process exit.
// @return {Object}             - The live `db` object.
function load(saveOnExit) {
    loadDB();
    loadCode();

    if (saveOnExit) {
        process.addListener('exit', function () {
            save();
        });
    }

    loaded = true;
    return db;
}

// Resets the database to its last persisted state by re-running load()
// without registering an additional exit listener.  Because load() mutates
// the shared `db` object in-place, all existing references to `db` (including
// the REPL context) automatically see the reset state.
function reset() {
    load(false);
}


// Starts an interactive Node.js REPL session backed by the odot database.
// Loads the database (with automatic save on exit), then populates the REPL
// context with:
//   o        - the live database object
//   save()   - persist the current state
//   reset()  - reload from the last save point
//   recode() / rc() - hot-reload prototype scripts
//   map()    - register additional collections
//   context  - the REPL context itself (for introspection)
//
// Any additional key/value pairs in `refs` are also injected into the context.
//
// @param {string} [file]  - Optional path to the database JSON file (overrides default).
// @param {Object} [refs]  - Optional extra variables to inject into the REPL context.
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

    context.o = db;          // The database, accessible as `o` in the REPL
    context.save = save;     // Persist current state
    context.reset = reset;   // Reset to last save point
    context.recode = context.rc = loadCode; // Hot-reload prototype scripts
    context.map = map;       // Register new collections at the prompt
    context.context = context; // Expose the context for introspection
}


exports.map = map;
exports.load = load;
exports.repl = repl;
exports.save = save;
exports.reset = reset;
exports.recode = exports.rc = loadCode;
