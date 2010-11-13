/*global many */

var mile = 0;  // Set default value of on station prototype

many('train');  // Create a many relation with trains

function name() { // Custom function for printing out station name
    return 'station ' + this.id + ' at ' + this.mile;
}
