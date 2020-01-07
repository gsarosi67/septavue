const util = require('util');
const promisify = require('promisify-node');
const fetch = require('node-fetch');
const graphql = require('graphql-request');
var stream = require('stream');
const unzip = require('unzip');  /* includes a lot of dependencies, is there an alternative? */
const streamBuffers = require('stream-buffers');
var fs = promisify("fs");
const githubBearer = require('./github_bearer');

var fileModDate;
var forceUpdate = false;
var githubUri = "https://github.com";
var gtfsFilename = "gtfs_public.zip";
var railzip = "google_rail.zip";
//var scheduleDir = "mostrecent-rail";
var scheduleDir;

const RETURN_ERROR = "Error";
const RETURN_NOUPDATE = "NoUpdate";
const RETURN_UPDATE = "Update";

var dataFiles = [
  {filename: "stop_times.txt"},
  {filename: "stops.txt"},
  {filename: "trips.txt"},
  {filename: "calendar.txt"}
];

exports.checkForNewData = function () { return checkForNewData(); };
exports.getCurrentRelease = function (response) { return getCurrentRelease(response); };
exports.getFileModifiedDate = function (path) { return getFileModifiedDate(path); };
exports.getlatestGTFSrelease = function () { return getlatestGTFSrelease(); };



 /*
       Determine the existence of new schedule data
         - data is now in GitHub : https://github.com/septadev/GTFS
         - GraphQL API to find the latest release
	     - the resourcePath is a path to an HTML document that has a link to the updated zip file.
	       The URL to this zip file looks like this:
			            - https://github.com/septadev/GTFS/releases/download/v20171113/gtfs_public.zip
	     - not sure if this is reliable, but it looks like I could just use the resourcePath
			      and replace "tag" with "download" and add "/gtfs_public.zip" to the end.
		 - this is the path for now...

*/


  function checkForNewData() {
    return (new Promise(function(resolve, reject) {
       if (process.env.RAIL_DATA_DIRECTORY != undefined) {
          scheduleDir = process.env.RAIL_DATA_DIRECTORY;
          console.log("Data directory set to: " + scheduleDir);
       }
       else {
          console.log("environment variable RAIL_DATA_DIRECTORY must be set")
          //process.exit(-1);
          reject(RETURN_ERROR + " RAIL_DATA_DIRECTORY must be set");
       }

       if (process.env.RAIL_UPDATE_FORCE_UPDATE != undefined) {
   		 forceUpdate = true;
   	 }

       var currentDate = new Date();
       console.log("*** Update Started (" + currentDate.toUTCString() + ") ***");

   	  getFileModifiedDate(scheduleDir + "/" + dataFiles[0].filename).then(function(date) {
   		   fileModDate = date;
   		   return(getlatestGTFSrelease());
   	  }).then(function(response) {
   		   //console.log(JSON.stringify(response));
   		   var releaseDate = new Date(response.repository.releases.nodes[0].updatedAt);
   		   //var releaseDate = response.repository.releases.nodes[0].updatedAt;

   		   if (forceUpdate || (releaseDate.getTime() > fileModDate.getTime())) {
   			    if (forceUpdate) {
   			       console.log("*** Test Run *** fetch data and update files regardless of date ***");
   			    }
   			    console.log("releaseDate: " + releaseDate.toUTCString() + " is newer than file modified date: " + fileModDate.toUTCString());
   			    console.log("Fetch new data");
   			    getCurrentRelease(response).then(function(){
                    resolve(RETURN_UPDATE);
                })
                .catch(function(err) {
                   reject(RETURN_ERROR + "getting release " + err);
                });
   		   }
   		   else {
   			    console.log("releaseDate: " + releaseDate.toUTCString() + " is older than file modified date: " + fileModDate.toUTCString()	);
   			    console.log("No data fetch");
                resolve(RETURN_NOUPDATE);
   		   }
   	  })
   	  .catch(function(err) {
   	     console.log("[checkForNewData]: " + err);

   	     /* file stat failed, so get a new release */
   	     console.log("[checkForNewData]: File info failed");

           console.log("[checkForNewData]: Create " + scheduleDir + " Directory");
           fs.mkdir(scheduleDir).then(function() {
              console.log("[checkForNewData]: created directory, fetching release data");
   	        return getlatestGTFSrelease();
           }).then(function(response) {
   		     return getCurrentRelease(response);
           }).then(function() {
              resolve(RETURN_UPDATE);
   	     })
   	     .catch(function(error) {
   		      console.log("[checkForNewData]: " + error);
               reject(RETURN_ERROR + error);
   	     });
   	  });
     }));
  }


  /****  Need to put this inside of a promise ****/

  function getCurrentRelease(response)
  {
     return (new Promise(function(resolve, reject) {
        /* create URL */
        console.log("[getCurrentRelease]: resourcePath: " + response.repository.releases.nodes[0].resourcePath);
        var gtfsUri = githubUri + response.repository.releases.nodes[0].resourcePath.replace(/tag/,'download') + "/" + gtfsFilename;
        console.log("[getCurrentRelease]: resourceUri: " + gtfsUri);

        /* fetch zip file */
        fetch(gtfsUri).then(function(gtfsResponse) {
            return gtfsResponse.buffer();  // Response implements Body so this is a method that returns a promise!!
		    }).then(function(data) {
            /* load zip file */
            console.log("[getCurrentRelease]: Received: " + gtfsFilename);

            dataFiles.forEach(function(file) {
   				   //file.ws = new fs.createWriteStream(scheduleDir + "/" + file.filename,{flags: 'w',encoding: 'utf8'});
                  file.ws = fs.createWriteStream(scheduleDir + "/" + file.filename,{flags: 'w',encoding: 'utf8'});
                  file.ws.on('error', function(err) {
                     console.log("[getCurrentRelease]: " + err);
                     reject(err);
                  });
            });

            try {
              // Initiate the source
              var bufferStream = new stream.PassThrough();
              bufferStream.end(data);

              // Pipe it to unzip
      	      bufferStream
                .pipe(unzip.Parse({verbose: true}))
                .on('entry', function (entry) {
          	   var fileName = entry.path;
          	   console.log("[getCurrentRelease]: Master File Entry: " + fileName);

                   if (fileName === railzip) {
                      entry.pipe(unzip.Parse({verbose: true}))
          		   .on('entry',function(e) {
                              var bPiped = false;  // blah
                              dataFiles.forEach(function(file) {
              		         if (e.path === file.filename) {
              		            console.log("[getCurrentRelease]: " + JSON.stringify(e.path));
              			    e.pipe(file.ws);
                                    bPiped = true;
              		         }
                              });
                              if (!bPiped) {
                                e.autodrain();
                              }
          		   })
          		   .on('close',function(e) {
                             console.log("[getCurrentRelease]: close ");
                             resolve();
                           });
                   }
                   else {
		      entry.autodrain();
		   }
	        });
	    }
	    catch (err) {
	       console.log("[getCurrentRelease]: Error extracting zip file: " + err);
               reject(err);
            }
        })
        .catch(function (err) {
           console.log("[getCurrentRelease]: Error: " + err);
           reject(err);
        });
     }));
  }

  function getFileModifiedDate(path)
  {
    if (path) {
      return (fs.stat(path).then(function(stats) {
        console.log("[getFileModifiedDate]: path: " + path + " mtime: " + stats.mtime);
        return (new Date(stats.mtime));
     }));
      /*
      .catch(function() {
         console.log("[getFileModifiedDate]: Error reading file stats for " + path);
      });
      */
    }
    else {
      throw new Error('path is undefined');
    }
  }

  function getlatestGTFSrelease()
  {
    return (new Promise(function(resolve, reject) {
       var uri = "https://api.github.com/graphql";
       var client = new graphql.GraphQLClient(uri, {
		   headers: {
			  Authorization: 'Bearer ' + githubBearer.bearer,
		   },
	   });
	   var query = `{
		   repository(owner:"septadev", name: "GTFS") {
			releases(last: 1) {
			  nodes {
				name,
				id,
				updatedAt,
				resourcePath,
				tag {
				  id
				}
			  }
			}
		  }
		}`;

		client.request(query).then(function(response) {
		    resolve(response);
		})
		.catch (function (err) {
		    reject(err);
		});
   }));
  }
