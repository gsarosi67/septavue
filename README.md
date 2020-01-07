# SeptaVue

## Summary
Simple vue.js application to search and display the train schedule for Philadelphia's SEPTA regional rail.  The goals of this project are twofold, first to have a simple interface to see the trains that I care about, and second to try difference approaches for implementing the same functionality.

* The septa schedule data is stored at https://github.com/septadev/GTFS in Google GTFS format (https://gtfs.org/).

* Currently deployed version can be found at: (https://www.sarosi.net/septavue)

## Architecture
The application is broken in the 3 separate modules:
 * client application which uses the vue.js framework to display the results of the search
 * raildataservice - a node.js application the exposes a simple rest api for the client to get the data
 * updateraildata - a node.js application that pools the data repository and updates the private data store.

 The backend was implemented using 3 varying methods:
 * inmem - runs as a service and reads and parses the schedule data and stores all of the data in memory
 * dyno - runs as a service and stores and queries the schedule data in DynamoDB
 * lamba - runs as a serverless api in AWS Lambda stores and queries the schedule data in DynamoDB.  This is the currently deployed version.

## Additional information

* For train status information the application calls (https://www.septastats.com/api)
