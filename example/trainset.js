/*global require */

var odot = require('../'),
    map = odot.map;

// console.log(process.argv[1]);
map('station', 'station.js');
map('train', 'train.js');

odot.repl();

// Repl-less usage
// var o = odot.load();
// console.log(o.station.alpha);
