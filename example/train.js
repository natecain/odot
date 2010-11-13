/*global one, station */

var speed = 10; // Set default miles per hour on train prototype

one('station'); // Create relation with one train

function travel(destination) { // Function for train prototype
    var distance = destination.mile - this.station.mile,
        hours = distance / this.speed;

    this.station = destination;
    this.station.add(this);
    return this.id + ' now at ' + this.station.id + ' after ' + 
             hours + ' hours travel';
    // return this.id + ' goes to ' + this.station.id + ', travel time ' + 
    //          hours + ' hours';
}
