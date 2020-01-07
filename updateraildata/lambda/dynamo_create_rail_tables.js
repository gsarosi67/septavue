const util = require('util');
const promisify = require('promisify-node');
const fetch = require('node-fetch');
const AWS= require('aws-sdk');
var dyn;
if (process.env.RAIL_SERVICE_LOCAL != undefined) {
    AWS.config.update({region:'us-east-2',endpoint: 'http://localhost:8000'});
    dyn= new AWS.DynamoDB({ endpoint: new AWS.Endpoint('http://localhost:8000') });
}
else {
    AWS.config.update({region:'us-east-2'});
    dyn= new AWS.DynamoDB();
}
const docClient = new AWS.DynamoDB.DocumentClient();
const graphql = require('graphql-request');
var stream = require('stream');
const unzip = require('unzip');  /* includes a lot of dependencies, is there an alternative? */
const streamBuffers = require('stream-buffers');
const githubBearer = require('./github_bearer');


const OUTBOUND = 1;
const INBOUND = 0;         /* seems that the septa values are reversed from the spec */
const MAXLISTTRY = 20;
const INTERVALTIME = 5000; /* 5 seconds */

var dbTableCreateDate;
var forceUpdate = false;
var githubUri = "https://github.com";
var gtfsFilename = "gtfs_public.zip";
var railzip = "google_rail.zip";


/* stream buffers */
var sbStopTimes;
var sbStations;
var sbTrips;
var sbCaldays;

/* Parsed data objects */
var stopTimes;
var stations;
var trips;
var tripdays;
var caldays;

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

		 *** To Do ***
		 Replicate the logic in raildataservice is use promises and batch operations to
		 control the putting of data.  This should lower the amount of write capacity units required
		 to update table, at the expense of performance.  But performance is not as important since
		 updates are a rare occurrence.



*/


exports.handler = (event, context) => {

    if (process.env.RAIL_UPDATE_FORCE_UPDATE != undefined)
	  {
		   forceUpdate = true;
	  }

    var currentDate = new Date();
    console.log("*** Update Started (" + currentDate.toUTCString() + ") ***");
    if (context != undefined) {
        console.log("   ** AWS Lambda Context **");
        console.log("   functionName: " + context.functionName);
        console.log("   awsRequestId: " + context.awsRequestId);
        console.log("   logGroupName: " + context.logGroupName);
        console.log("   logStreamName: " + context.logStreamName);
        console.log("   Time Remaining: " + context.getRemainingTimeInMillis() + " ms");
    }

	getCurrentTableDate().then(function(date) {
		//console.log("timeinthen: " + date.getTime());
		dbTableCreateDate = date;
		return(getlatestGTFSrelease());
	}).then(function(response) {
		//console.log(JSON.stringify(response));
		var releaseDate = new Date(response.repository.releases.nodes[0].updatedAt);
		//var releaseDate = response.repository.releases.nodes[0].updatedAt;

		if (forceUpdate || (releaseDate.getTime() > dbTableCreateDate.getTime()))
		{
			if (forceUpdate) {
			   console.log("*** Test Run *** fetch data and update DB regardless of date ***");
			}
			console.log("releaseDate: " + releaseDate.toUTCString() + " is newer than table createDate: " + dbTableCreateDate.toUTCString());
			console.log("Fetch new data");

			getCurrentRelease(response);
		}
		else
		{
			console.log("releaseDate: " + releaseDate.toUTCString() + " is older than table createDate: " + dbTableCreateDate.toUTCString()	);
			console.log("No data fetch");
		}
	})
	.catch(function(err) {
	   console.log("Error: " + err);

	   /* Database Table Info failed, so get a new release */
	   console.log("Database info failed, fetching new release");
	   getlatestGTFSrelease().then(function(response) {
		   getCurrentRelease(response);
	   })
	   .catch(function(giterror) {
		   console.log("Error getting release info: " + err);
	   });
	});

};

if (process.env.RAIL_SERVICE_LOCAL != undefined) {
   exports.handler();
}

function getCurrentRelease(response)
{
        /* create URL */
        console.log("[getCurrentRelease]: resourcePath: " + response.repository.releases.nodes[0].resourcePath);
        var gtfsUri = githubUri + response.repository.releases.nodes[0].resourcePath.replace(/tag/,'download') + "/" + gtfsFilename;
        console.log("[getCurrentRelease]: resourceUri: " + gtfsUri);

        /* fetch zip file */
        fetch(gtfsUri).then(function(response) {
            return response.buffer();  // Response implements Body so this is a method that returns a promise!!
		    }).then(function(data) {
            /* load zip file
                 - Would really prefer not to save the file.  If the source of truth is in
                   github, why spend resources ($) saving these files?
            */
            console.log("[getCurrentRelease]: Received: " + gtfsFilename);

            try {
      				// Destinations
      				sbStopTimes = new streamBuffers.WritableStreamBuffer({
      					initialSize: (1024 * 1024),   // start at 1MB.
      					incrementAmount: (100 * 1024) // grow by 100 kilobytes each time buffer overflows.
      				});
      				sbStations = new streamBuffers.WritableStreamBuffer({
      					initialSize: (20 * 1024),   // start at 20KB.
      					incrementAmount: (10 * 1024) // grow by 10 kilobytes each time buffer overflows.
      				});
      				sbTrips = new streamBuffers.WritableStreamBuffer({
      					initialSize: (100 * 1024),   // start at 100 KB.
      					incrementAmount: (10 * 1024) // grow by 10 kilobytes each time buffer overflows.
      				});
      				sbCaldays  = new streamBuffers.WritableStreamBuffer({
      					initialSize: (1 * 1024),   // start at 1 KB.
      					incrementAmount: (1 * 1024) // grow by 1 kilobytes each time buffer overflows.
      				});

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
              						 var fName = e.path;

              						 if (fName === 'stop_times.txt') {
              							  console.log("[getCurrentRelease]: " + JSON.stringify(fName));
              							  e.pipe(sbStopTimes);
              						 }
              						 else if (fName === 'stops.txt') {
              							  console.log("[getCurrentRelease]: " + JSON.stringify(fName));
              							  e.pipe(sbStations);
              						 }
              						 else if (fName === 'trips.txt') {
              							  console.log("[getCurrentRelease]: " + JSON.stringify(fName));
              							  e.pipe(sbTrips);
              						 }
              						 else if (fName === 'calendar.txt') {
              							  console.log("[getCurrentRelease]: " + JSON.stringify(fName));
              							  e.pipe(sbCaldays);
              						 }
              						 else
              						 {
              							  e.autodrain();
              						 }
          					  })
          					  .on('close',function() {
          							 console.log("[getCurrentRelease]: sbStopTimes.size= " + sbStopTimes.size());
          							 //console.log(sbStopTimes.getContentsAsString('utf8', 80) + "\n");

          							 console.log("[getCurrentRelease]: sbStations.size= " + sbStations.size());
          							 //console.log(sbStations.getContentsAsString('utf8', 80) + "\n");

          							 console.log("[getCurrentRelease]: sbTrips.size= " + sbTrips.size());
          							 //console.log(sbTrips.getContentsAsString('utf8', 80) + "\n");

          							 console.log("[getCurrentRelease]: sbCaldays.size= " + sbCaldays.size() + "\n");
          							 //console.log(sbCaldays.getContentsAsString('utf8', 80) + "\n");

          							 updateTables();
          					  });
					} else {
					   entry.autodrain();
					}
			  });
		    }
		    catch (err) {
		       console.log("[getCurrentRelease]: Error extracting zip file: " + err);
		    }
        })
        .catch(function (err) {
           console.log("[getCurrentRelease]: Error: " + err);
        });
}



function getCurrentTableDate()
{
    return (new Promise(function(resolve, reject) {
	   /* Get the creation date of one of the current db tables */
		dyn.describeTable({TableName: "Stopsbytrain"}, function(err,data) {
		  if (err) {
				//console.error("List Tables Error: " + err);
				reject("describe Tables Error: " + err);
			 }
			 else {
			    //console.log("Timefromdynamo: " + JSON.stringify(data.Table.CreationDateTime));
			    resolve(new Date(data.Table.CreationDateTime));
			 }
		});
	}));
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


  /* Process the rail data files and create dynamodb tables for searching

       - Tables to create:

		     Changing to 4 Tables:

		     Calendar:  should have already had this, just the contents of the caldays object
		                created from the calendar.txt file.
		                Primary Key: Partition_key (HASH): service_id (String)
		                each Item is a Map of days with binary value indicating rail service on that day

		     Stations:  should have already had this.  Contents of the stations object
		                created from the stops.txt file.
		                Primary Key: Partition_key (HASH): stop_id (String) (could be int, do we care?)
		                each Item is a Map of each Station or stop description Name, Desc, Lat, Lon, Zone, Handicap Access (boolean)

		     Trainsbystop:  Primary Key: Partition Key (HASH): service_id (String) (also called day_id, this will change)
		                                   Sort Key (RANGE): stop_id (String) (could be int)
		                                   each Item is a a list of Trains that stop at the cooresponding stop_id
		                                   each train list item will have a trainnum and direction (inbound or outboud)

		     Stopsbytrain:  Primary Key: Partition Key (HASH): service_id (String)
		     							 Sort Key (RANGE): trainnum (String) (could be int)
		     							 each Item will be a Map of train info: (trainnum and direction)
		     							 and a map of stops for the train.
		     							 each map item will contain:
		     							    trip_id:
											arrival_time:
											departure_time:
											stop_id:
											stop_sequence:
											pickup_type:
											drop_off_type:

    */


  //updateTables("20171013155638");

  function updateTables() {
		deleteTables();
		waitforEmptyList().then(function(results) {
			console.log(results);

			createTables();

			/* not sure I need this waitfor here, but I like to have it with the Promise
			   then I know at least one table has been created before starting the
			   data load.

			   Each Data load function below does a waitFor before starting the data load,
			   so we should be covered.  It might be cleaner to put the waitfor here using
			   the Promise version....

			*/
			waitFor("tableExists",{TableName: "Trainsbystop"}).then(function(results) {
				//console.log(results);
				calendarData();
				stationsData();
				stopsbytrainData();
				trainsbystopData();
			});
		})
		.catch (function(err) {
			console.error(err);
		});
  }

  function createTables()
  {
      /* Next read data from files */
        console.log("\n[createTables]: Before initrailData");

       initrailData();

           /*  create the empty tables

           ***  Need to figure out the right values for Read and Write Capacity Units ***

                 Solve this before installing this as a proces/daemon that automatically
                 updates the DB.

             * Initial load of data failed for Stopbytrain with 10 Write Units
             * Load succeeded with increased to 1000 Write Units
             * at 1000 Write Units cost for DB would be over $500 per month
             * Need to figure out the minimum write value and/or throttle the writes
             * DB is never updated!! With new data we delete and rebuild, after data load
               we need to update write units to as low as possible (1? 0?).
             * What is the correct value for Read Units?

           */

           /* calendar */
		   var params = {
				TableName : "Calendar",
				KeySchema: [
					{ AttributeName: "service_id", KeyType: "HASH"},  //Partition key
				],
				AttributeDefinitions: [
					{ AttributeName: "service_id", AttributeType: "S" },
				],
				ProvisionedThroughput: {
					ReadCapacityUnits: 5,
					WriteCapacityUnits: 10  /* just for creation, then lower to 1 */
				}
		   };
		   dyn.createTable(params, function(err, data) {
			   if (err) {
				   console.error("[createTables]: Unable to create table. Error:" + JSON.stringify(err, null, 2));
			   } else {
				   console.log("[createTables]: Created table:" + data.TableDescription.TableName);
			   }
		   });


           /* stations */
		   var params = {
				TableName : "Stations",
				KeySchema: [
					{ AttributeName: "stop_id", KeyType: "HASH"},  //Partition key
				],
				AttributeDefinitions: [
					{ AttributeName: "stop_id", AttributeType: "S" },
				],
				ProvisionedThroughput: {
					ReadCapacityUnits: 5,
					WriteCapacityUnits: 10  /* just for creation, then lower to 1 */
				}
		   };
		   dyn.createTable(params, function(err, data) {
			  if (err) {
				  console.error("[createTables]: Unable to create table. Error:" + JSON.stringify(err, null, 2));
			  } else {
				  console.log("[createTables]: Created table:" + data.TableDescription.TableName);
			  }
		   });

			/* Create Stopsbytrain table */
			 var params = {
					TableName : "Stopsbytrain",
					KeySchema: [
						{ AttributeName: "service_id", KeyType: "HASH"},  //Partition key
						{ AttributeName: "trainnum", KeyType: "RANGE" }  //Sort key
					],
					AttributeDefinitions: [
						{ AttributeName: "service_id", AttributeType: "S" },
						{ AttributeName: "trainnum", AttributeType: "S" }
					],
					ProvisionedThroughput: {
						ReadCapacityUnits: 10,
						WriteCapacityUnits: 100   /* just for creation, then lower to 1 */
					}
			};


			dyn.createTable(params, function(err, data) {
				if (err) {
					console.error("[createTables]: Unable to create table. Error:" + JSON.stringify(err, null, 2));
				} else {
					console.log("[createTables]: Created table:" + data.TableDescription.TableName);
				}
			});

			/* Create Trainsbystop table */

			var params_tbs = {
					TableName : "Trainsbystop",
					KeySchema: [
						{ AttributeName: "service_id", KeyType: "HASH"},  //Partition key
						{ AttributeName: "stop_id", KeyType: "RANGE" }  //Sort key
					],
					AttributeDefinitions: [
						{ AttributeName: "service_id", AttributeType: "S" },
						{ AttributeName: "stop_id", AttributeType: "S" }
					],
					ProvisionedThroughput: {
						ReadCapacityUnits: 30,   /* just for creation, then lower to 5 */
						WriteCapacityUnits: 30   /* just for creation, then lower to 1 */
					}
			};

			dyn.createTable(params_tbs, function(err, data) {
				if (err) {
					console.error("[createTables]: Unable to create table. Error:" + JSON.stringify(err, null, 2));
				} else {
					console.log("[createTables]: Created table:" + data.TableDescription.TableName);
				}
			});
   }

   function waitFor(event,params)
   {
        return new Promise(function(resolve, reject) {
   		   dyn.waitFor(event,params,function(err,data) {
   		       if (err) {
				   reject(err);
			   } else {
   		           resolve(data);
   		       }
   		   });
   		});
   }

   function calendarData()
   {
       dyn.waitFor('tableExists',{TableName: "Calendar"}, function(err,data) {
			if (err) {
			   console.error("[calendarData]: table waitFor Error: " + err);
			}
			else {
			   /* Add data to calendar table */
				var params = new Object();
					params.RequestItems = new Object();
					params.RequestItems['Calendar'] = [];

				console.log("\ncalendarData]: populating Calendar");

				var i = 0;
				for (var service_id in caldays) {
					params.RequestItems['Calendar'][i++] = {
					   PutRequest: {
						   Item: caldays[service_id]
					   }
				   }
				}

				docClient.batchWrite(params,function(err, data) {
					if (err) {
						console.error("calendarData]: Calendar batchWrite error: Error: " + JSON.stringify(err, null, 2) + "\n");
					} else {
						console.log("calendarData]: Calendar batchWrite succeeded\n");

						updateThroughput("Calendar",5,1);
					}
				});
			}
		});
   }

    /*** To Do
         Need to figure out a way to throttle the DB puts.  Since the put call is async,
         these loops are just firing off a bunch of puts and hoping for the best.

         It would be better to send a small number of puts (maybe using batchWrite)
         and then waiting for them to complete and sending the next group.

         What is the best way to accomplish this?
           - use a custom event to control the flow
           - I don't think there are dynamo events that would help to control this
     */

	function stationsData()
	{
      /* stations */
      dyn.waitFor('tableExists',{TableName: "Stations"}, function(err,data) {
         if (err) {
            console.error("[stationsData]: table waitFor Error: " + err);
         }
         else {
            console.log("[stationsData]: populating Stations");

            var stationPromises = [];
            var index=0;
            for (var station in stations) {
               var params = {
                  TableName: "Stations",
                  Item: stations[station]
               }
               console.log("[stationsData]: " + station + " : " + JSON.stringify(stations[station]));
               var request = docClient.put(params);
               stationPromises[index++] = request.promise();
            }
            console.log("\n");
            Promise.all(stationPromises).then(function(values) {
               console.log("[stationsData]: " + values.length + " items added to Stations table\n");

               /* Change Read and Write Capacity Units */
               updateThroughput("Stations",5,1);

            }).catch (function(reason) {
               console.error("[stationsData]: Stations Put Error: " + reason + "\n");
            });
        }
      });
   }

	function stopsbytrainData()
	{
		/* Add data to stopsbytrain table */
			dyn.waitFor('tableExists',{TableName: "Stopsbytrain"}, function(err,data) {
				if (err) {
				   console.error("[stopsbytrainData]: table waitFor Error: " + err);
				}
				else {
				    console.log("[stopsbytrainData]: populating Stopbytrain");
				    var sbtPromises = [];
				    var index = 0;
            		for (var dayid in tripdays) {
					    for (var train in tripdays[dayid].trains) {
							//console.log("Day: " + dayid + " Train: " + train);

							var params = {
								TableName: "Stopsbytrain",
								Item: {
								   "service_id" : dayid,
									"trainnum" : tripdays[dayid].trains[train].trainnum,
									"direction" : tripdays[dayid].trains[train].direction,
									"stops" : tripdays[dayid].trains[train].stops
								}
							}

							var request = docClient.put(params);
							sbtPromises[index++] = request.promise();
						}
					}
					Promise.all(sbtPromises).then(function(values) {
				        console.log(values.length + " items added to Stopsbytrain table\n");

				        /* Change Read and Write Capacity Units */
				        updateThroughput("Stopsbytrain",10,1);

					}).catch (function(reason) {
						console.error("[stopsbytrainData]: Stopsbytrain put error: " + reason + "\n");
					});
				}
			});
	}

	function trainsbystopData()
	{
	    var trainsbystop = new Object();

	    console.log("[trainsbystopData]: populating Trainsbystop");

			/* First create the trainsbystop object in memory */
	    for (var dayid in tripdays) {
  			for (var station in stations) {
  				for (var train in tripdays[dayid].trains) {
  					if (tripdays[dayid].trains[train].stops[station] != undefined) {
  						  var direction = tripdays[dayid].trains[train].direction;
  						  if (trainsbystop[dayid+station] == undefined) {
  							  trainsbystop[dayid+station] = new Object();
  							  trainsbystop[dayid+station].service_id = dayid;
  							  trainsbystop[dayid+station].stop_id = station;
  							  trainsbystop[dayid+station].trains = [];
  						  }
  						  trainsbystop[dayid+station].trains.push({trainnum: train, direction: direction});
  					}
  				}
  			}
		  }

		dyn.waitFor('tableExists',{TableName: "Trainsbystop"}, function(err,data) {
			if (err) {
			   console.error("[trainsbystopData]: table waitFor Error: " + err);
			}
			else {
				 /* Populate trainsbystop table */
				 var tbsPromises = [];
				 var index = 0;
				 for (var day_station in trainsbystop) {
  					var params = {
  						TableName: "Trainsbystop",
  						Item: {
  							"service_id" : trainsbystop[day_station].service_id,
  							"stop_id" : trainsbystop[day_station].stop_id,
  							"trains" : trainsbystop[day_station].trains
  						}
  					}

  					var request = docClient.put(params);
  					tbsPromises[index++] = request.promise();
  			 }

				 Promise.all(tbsPromises).then(function(values) {
				    console.log("[trainsbystopData]: " + values.length + " items added to Trainsbystop table\n");

				    /* Change Read and Write Capacity Units */
				    updateThroughput("Trainsbystop",5,1);

				 }).catch (function(reason) {
				    console.error("[trainsbystopData]: Trainsbystop put error: " + reason + "\n");
				 });
			}
    });
 }

    function updateThroughput(tableName,readUnits,writeUnits)
    {
        var params = {
          ProvisionedThroughput: {
		      ReadCapacityUnits: readUnits,
		      WriteCapacityUnits: writeUnits
		   },
		   TableName: tableName
		};

		dyn.updateTable(params, function(err,data) {
		    if (err) {
		        console.error("[updateThroughput]: Update Throughput Error (" + tableName + "): " + err);
		    }
		    else {
		       console.log("[updateThroughput]: " + data.TableDescription.TableName + " throughput updated:");
		       console.log("[updateThroughput]: " + JSON.stringify(data.TableDescription.ProvisionedThroughput) + "\n");
		    }
		});
    }

    function deleteTables()
    {
		/* First delete current tables
		  - in the future could just update what changes
		*/
		dyn.listTables({}, function(err,data) {
		 if (err) {
			 console.error("[deleteTables]: List Tables Error: " + err);
		 } else {
			data.TableNames.forEach(function(table) {
				console.log("[deleteTables]: waitFor: " + table);
				dyn.waitFor('tableExists',{TableName: table}, function(err,data) {
					if (err) {
					   console.error("[deleteTables]: table waitFor Error: " + err);
					} else {
						console.log("[deleteTables]: deleting " + data.Table.TableName);
						dyn.deleteTable({TableName: data.Table.TableName}, function(err,data) {
						   if (err) {
							  console.error("[deleteTables]: Error deleting table: " + err);
						   } else {
							  console.log("[deleteTables]: Table " + data.TableDescription.TableName + " deleted.");
						   }
						});
					}
				});
			});
		 }
		});
	}

	function waitforEmptyList()
	{
		  /* I want to wait until the tables are deleted, but how can I be sure all tables
			 are deleted?  i.e. how do I wait for all tables??

			 - not sure this is the best method, but I will call listTables every
			   INTERVALTIME seconds, until I get an empty list, or call listTables more than
			   MAXLISTTRY times
		  */
		  return new Promise(function(resolve, reject) {
			  var intervalCount = 0;
			  var intervalObj = setInterval( function() {
				  dyn.listTables({}, function(err,data) {
					 if (err) {
						//console.error("List Tables Error: " + err);
						clearInterval(intervalObj);
						reject("[waitforEmptyList]: List Tables Error: " + err);
					 }
					 else {
						if (data.TableNames.length == 0) {
						   console.log("[waitforEmptyList]: Table List Empty");
						   clearInterval(intervalObj);

						   resolve("[waitforEmptyList]: Table List Empty");

						}
						else if (intervalCount > MAXLISTTRY) {
						   //console.log("MAX intervals reached");
						   clearInterval(intervalObj);
						   reject("[waitforEmptyList]: MAX intervals reached");
						}
						else {
						   console.log("[waitforEmptyList]: intervalCount: " + intervalCount);
						   intervalCount++;
						}
					 }
				  })
			  },INTERVALTIME);
		 });
	}

    function initrailData()
    {
		console.log("\n[initrailData]: processing...sbStopTimes");
		stopTimes = csvparse(sbStopTimes.getContentsAsString('utf8'),true);

		console.log("[initrailData]: processing sbStations");
		stations = csvparse(sbStations.getContentsAsString('utf8'),true,"stop_id");

		console.log("[initrailData]: processing...sbTrips");
		trips = csvparse(sbTrips.getContentsAsString('utf8'),true,"trip_id");

		console.log("[initrailData]: processing...sbCaldays");
		caldays = csvparse(sbCaldays.getContentsAsString('utf8'),true,"service_id");

		console.log("[initrailData]: Rail data reading complete");

		   /* create tables/arrays to make searching faster...
			  The entire point of this app is to be able to search based on a
			  specific station, i.e. what trains include the stop where I get on and
			  and where I get off, and what are the times.

			  - Create an object for each day code in the tripdays array
				- each daycodeobject will have a list of train objects
				- each train object will have a list of stops.
					- this is key: use the stop_id as the object member name, this will make finding a stop faster
		   */

		tripdays = new Object();
		for (var trip in trips) {
		   if (tripdays[trips[trip].service_id] == undefined)
		   {
			  tripdays[trips[trip].service_id] = new Object();
			  tripdays[trips[trip].service_id].trains = new Object();
		   }
		   if (tripdays[trips[trip].service_id].trains[trips[trip].block_id] == undefined)
		   {
			  tripdays[trips[trip].service_id].trains[trips[trip].block_id] = new Object();
			  tripdays[trips[trip].service_id].trains[trips[trip].block_id].trainnum = trips[trip].block_id;
			  tripdays[trips[trip].service_id].trains[trips[trip].block_id].direction = trips[trip].direction_id;
			  tripdays[trips[trip].service_id].trains[trips[trip].block_id].stops = new Object();
		   }
		}
		for (var index in stopTimes) {
			if (stopTimes[index]) {
				var trip = stopTimes[index].trip_id;
				tripdays[trips[trip].service_id].trains[trips[trip].block_id].stops[stopTimes[index].stop_id] = stopTimes[index];
			}
		}
  }

	function csvparse(csvdata,headerRow,headIndexLabel)
	{
  		if (csvdata)
  		{
  		  try {
    			var headers;
    			var headerIndex = -1;

    			console.log("\n[csvparse]: headerRow: " + headerRow + " headIndexLabel: " + headIndexLabel);

    			/* Split data by line breaks */
    			var datalines = csvdata.split(/\n|\r\n/);
    			console.log("[csvparse]: Number of lines: " + datalines.length);

    			if (headerRow) {
      				headers = datalines[0].trim().split(/,/);
      				//console.log(headers);
      				if (headIndexLabel != undefined) {
      				   headerIndex = headers.findIndex(function(label) { return(label == headIndexLabel); });
      				   console.log("[csvparse]: headerIndex: " + headerIndex);
      				}
    			}

  		    var results = new Object();
  		    for (var rindex = (headerRow ? 1 : 0); rindex < datalines.length; rindex++) {
  				    /* divide line by comma */
  				    var values = datalines[rindex].trim().split(/,/);

              if (values.length === headers.length) {
        					var lineObj = new Object();
        					values.forEach(function(value,i) {
                      var fieldname;
          					  if(headers && headers[i]) {
                          fieldname = headers[i].trim();
                      }
                      else {
                          fieldname = parseInt(i);
                      }
                      if (value == "") {
                          console.log("[csvparse(line num " + rindex + ")]: Empty Value for " + fieldname);
                          value = "empty";
                      }
      						    lineObj[fieldname] = value;
        					});
        					//console.log(lineObj);
        					if (headers && headerIndex > -1) {
        					    results[values[headerIndex]] = lineObj;  /* this is key, use the headerIndex value as the object attribute Name
                                                                  allows for a much quicker access of the data */
        					}
        					else {
        						  results[parseInt(rindex)] = lineObj;
        					}
      				}
      				else {
  					      console.log("[csvparse]: Row skipped: values.length=" + values.length + " headers.length=" + headers.length);
  				    }
  			  }
  			  return(results);
		    }
		    catch(err) {
		       console.error("[csvparse]: Error: ",err);
		    }
		  }
	}

  function objtoArray(obj)
  {
		  result = [];
		  var index = 0;
		  for (var item in obj) {
			  result[index++] = obj[item];
		  }
		  return result;
 }
