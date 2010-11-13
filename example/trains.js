/*global require */

var nodeo = require('../'),
    map = nodeo.map;

// console.log(process.argv[1]);
map('station', 'station.js');
map('train', 'train.js');

nodeo.repl();

// Repl-less usage
// var o = nodeo.load();
// console.log(o.station.alpha);


