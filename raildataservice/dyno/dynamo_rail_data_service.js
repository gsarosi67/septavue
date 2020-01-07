var util = require('util');
var promisify = require('promisify-node');
var https = require('https');
var http = require('http');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
var url = require('url');
var fetch = require('node-fetch');

var AWS= require('aws-sdk');
if (process.env.RAIL_SERVICE_LOCAL != undefined) {
    AWS.config.update({region:'us-east-2',endpoint: 'http://localhost:8000'});
}
else {
    AWS.config.update({region:'us-east-2'});
}
var docClient = new AWS.DynamoDB.DocumentClient();

var server;
var currentBatch;

const OUTBOUND = 1;
const INBOUND = 0;  /* seems that the septa values are reversed from the spec */
const BATCH_REQUEST_MAX = 10;
var PORT;

const septaStatsUri = "https://www.septastats.com/api/current/train/$train_number$/latest";


    init();

    function init()
    {
		/* Get the port from an environment variable */
		if (process.env.RAIL_SERVICE_PORT != undefined) {
		   PORT = process.env.RAIL_SERVICE_PORT;
		}
		else {
		   console.error("Error: RAIL_SERVER_PORT must be set");
		}

	  try {
			if ((process.env.RAIL_SERVICE_KEY != undefined) &&
			    (process.env.RAIL_SERVICE_CERT != undefined)) {
			    /* HTTPS */
				const options = {
					key: process.env.RAIL_SERVICE_KEY,
					cert: process.env.RAIL_SERVICE_CERT
				};
				console.log("SSL key and cert found, using HTTPS");
				server = https.createServer(options, handleRequest);
			}
			else    /* HTTP */
			{
				console.log("No SSL key and cert found, using HTTP");
				server = http.createServer(handleRequest);
			}

			server.listen(PORT, '::', function() {
				console.log("Server listening on port " + PORT);
			});

      dispatcher.onGet("/search",function(req,res) {
        //console.log("search");
				//console.log(req.url);
				var parsedUrl = url.parse(req.url,true);

				findtraindata(parsedUrl.query.keystation,
							  parsedUrl.query.stationlist.split(","),
							  parsedUrl.query.dayid,
							  (  parsedUrl.query.direction === undefined ? undefined :
								(parsedUrl.query.direction.toLowerCase() === "inbound" ? INBOUND : OUTBOUND)
							  ),
							  parsedUrl.query.start,parsedUrl.query.end)
				.then(function (results) {
	            res.writeHead(200, {'Content-Type': 'application/json'});
			        res.end(JSON.stringify(results));
			    }).catch(function(reason) {
				      console.log("Search Error: " + JSON.stringify(reason));
				      res.writeHead(501,{'Content-Type': 'application/json'});  /* find correct error number */
			        res.end(JSON.stringify({message: JSON.stringify(reason)}));
				});

			});


			dispatcher.onGet("/stations",function(req,res) {
			    docClient.scan({TableName:'Stations'},function(err,data) {
			        if (!err) {
                 res.writeHead(200, {'Content-Type': 'application/json'});
                 res.end(JSON.stringify(data.Items));
			        }
			        else {
                res.writeHead(500,{'Content-Type': 'application/json'});
                res.end(JSON.stringify({message: err.message}));
			        }
			    });
			});

			dispatcher.onGet("/calendar",function(req,res) {
			    docClient.scan({TableName:'Calendar'},function(err,data) {
			        if (!err) {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(data.Items));
 		          }
			        else {
                res.writeHead(500,{'Content-Type': 'application/json'});
                res.end(JSON.stringify({message: err.message}));
 		          }
			    });
			});


			dispatcher.onGet("/status", function(req,res) {
		     var parsedUrl = url.parse(req.url,true);
			   var trainnum = parsedUrl.query.num;

         if (trainnum != undefined) {
				    var uri = septaStatsUri.replace("$train_number$",trainnum);
				    console.log("status uri: " + uri);
				    fetch(uri).then(function(response) {
				        return response.text();  // Response implements Body so this is a method that returns a promise!!
				    }).then(function(text) {
				        console.log(text);
				        res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(text);
				    }).catch(function(reason) {
				        console.log("Error getting status: " + reason);
	            	res.writeHead(500, {'Content-Type': 'application/json'});
			    		  res.end(JSON.stringify({message: "Error: " + reason}));
				    });
			   }
			   else {
	          res.writeHead(400, {'Content-Type': 'application/json'});  /* find correct error number */
			    	res.end(JSON.stringify({message: "Error: train number must be valid"}));
			   }
			});
		}
		catch (err) {
		   console.log(err);
		}
  }

  function handleRequest(request, response)
  {
			try {
			    // Log request with date & time
				var d = new Date();
				console.log(d.toLocaleString() + " : " + request.url);

				// Set CORS headers
				response.setHeader('Access-Control-Allow-Origin', '*');
				response.setHeader('Access-Control-Request-Method', '*');
				response.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET');
				response.setHeader('Access-Control-Allow-Headers', '*');
				if ( request.method === 'OPTIONS' ) {
					response.writeHead(200);
					response.end();
					return;
				}

				dispatcher.dispatch(request, response);
			} catch(err) {
				console.log(err);
			}
	}


    function findtraindata(station,stationList,dayid,direction,starttime,endtime)
    {
           return new Promise(function(resolve, reject) {

			   /* step 1: Query Trainsbystop to get the list of trains for the station */
			   var params = {
					TableName : "Trainsbystop",
					KeyConditionExpression: "#day = :d and #stop = :st",
					ExpressionAttributeNames:{
						"#day" : "service_id",
						"#stop" : "stop_id"
					},
					ExpressionAttributeValues: {
						":d" : dayid,
						":st" : station
					}
				};

				docClient.query(params, function(err, stationTrains) {
					if (err) {
						console.error("Unable to query. Error:", JSON.stringify(err, null, 2));
						reject(err);
					} else {
						console.log("Query succeeded.");
						/*
						stationTrains.Items.forEach(function(item) {
							console.log(" -", item.stop_id + ": " + JSON.stringify(item.trains));
						});
						*/

						/* Filter for direction */
						var filteredTrains = stationTrains.Items[0].trains.filter(function(train) {
						     return (train.direction === direction.toString());
						});

						console.log("filteredTrains Length: " + filteredTrains.length);
//						console.log("filteredTrains: " + JSON.stringify(filteredTrains));

					    /* step 2: Query stopsbytrain for each train returned by the first query

					      - this BatchGetItems call is costing on average 34 read capacity units
					      - not terribly high, but the free tier has a limit of 25 total.
					      - how does this scale?
					      - how can I lower the read capacity units?
					      - I assume if you did the gets "slower" i.e. with some delay between them
					        it would reduce the capacity required. How can I do this without
					        causing too much latency?
					        - what if I removed the batchGet and just used get?  Would the this introduce
					          enough latency to lower the capacity used?
					        - do I need to introduce a small delay between each get item?
					    */

					    /* there has to be a way to use promises to group the requests
					       into smaller batches, i.e. 5 requests per call */

					   currentBatch = {
					       tableName : "Stopsbytrain",
					       sourcedata :  filteredTrains,
					       resolve : resolve,
					       reject : reject,
					       batchComplete : sbt_batchComplete,
					       dayid : dayid,
					       starttime : starttime,
					       endtime : endtime,
					       stationList : stationList,
					       responsedata : [],
					       start : 0,
					       num : Math.min(BATCH_REQUEST_MAX,filteredTrains.length),
					       next : Math.min(BATCH_REQUEST_MAX,filteredTrains.length),
					   }

					   /* Start batchGet async request loop

					   */
					   sendBatchRequest(currentBatch);
					}
				});
			});
    }

    function sendBatchRequest(batchRequest)
    {
		var gparams = new Object();
			gparams.RequestItems = new Object();
			gparams.RequestItems[batchRequest.tableName] = new Object();
			gparams.RequestItems[batchRequest.tableName].Keys = [];
			gparams.ReturnConsumedCapacity = "INDEXES";

		/* Create batchGet Request parameters, Key for each train */
		var sIndex = batchRequest.start;
		for (var i = 0; i < batchRequest.num; i++) {
			gparams.RequestItems[batchRequest.tableName].Keys[i] = {"service_id": batchRequest.dayid,
															          "trainnum": batchRequest.sourcedata[sIndex].trainnum };
			sIndex++;
		}

		/* Send batchGet request */
		docClient.batchGet(gparams).promise().then(getBatchResponse,batchError);

    }

    function getBatchResponse(data)
    {
        if (data) {
			console.log("Batch Response Received.");
			if (data.ConsumedCapacity != undefined) {
			  console.log(JSON.stringify(data.ConsumedCapacity));
			}
			else {
			  console.log("ConsumedCapacity undefined");
			}

			/* Copy data */
			currentBatch.responsedata = currentBatch.responsedata.concat(data.Responses[currentBatch.tableName]);
			console.log("Data added, new total: " + currentBatch.responsedata.length);

			if (currentBatch.next >= currentBatch.sourcedata.length) {
				 /* finished */
			   currentBatch.batchComplete()
			}
			else {
				 /* send next batch request */
			   currentBatch.start = currentBatch.next;
			   currentBatch.num = Math.min(BATCH_REQUEST_MAX,(currentBatch.sourcedata.length-currentBatch.start))
			   currentBatch.next = currentBatch.start + currentBatch.num;
			   sendBatchRequest(currentBatch);
			}
		}
    }

    function sbt_batchComplete()
    {
		var results = [];
		var rIndex = 0;

        if (currentBatch.responsedata == undefined || currentBatch.responsedata == null) {
              batchError({ message: "Error: response data undefined"});
        }

        console.log("Batch Complete: response data length: " + currentBatch.responsedata.length);

		/* Create the return result to only include stationList stops */
		currentBatch.responsedata.forEach(function(train) {
			 var ts = new Object();
			 ts.trainnum = train.trainnum;

			 if (currentBatch.stationList)
			 {
				 var stIndex = 0;
				 ts.stoptimes = [];
				 currentBatch.stationList.forEach(function(stn) {
					if (train.stops[stn] != undefined) {
					   ts.stoptimes[stIndex++] = train.stops[stn];
					}
				 });
			 }
			 else
			 {
				 /* convert to array */
				 ts.stoptimes = objtoArray(train.stops);
			 }

			 ts.stoptimes.sort( function (a,b) {
				 if (a.departure_time < b.departure_time) {
					return (-1);
				 } else if (a.departure_time > b.departure_time) {
					return (1);
				 } else {
					return (0);
				 }
			 });

			 results[rIndex++] = ts;
		});

		//console.log(JSON.stringify(results));
		if (results.length > 0) {

		   /* Now sort and filter the results to only include trains that have a
			  first stop departure time between starttime and endtime,
			  if startime and endtime are not defined, include them all
		   */
		   var filtered = results.sort(function (a,b) {
			  if (a.stoptimes.length > 0 && b.stoptimes.length > 0) {
				 if (a.stoptimes[0].departure_time < b.stoptimes[0].departure_time) {
					return (-1);
				 } else if (a.stoptimes[0].departure_time > b.stoptimes[0].departure_time) {
					return (1);
				 } else {
					return (0);
				 }
			  } else {
				 return(0);
			  }
		   }).filter(function (t) {
				return ( (t.stoptimes.length > 0) &&
						 ((currentBatch.starttime === undefined) || (t.stoptimes[0].departure_time > currentBatch.starttime)) &&
						 ((currentBatch.endtime === undefined) || (t.stoptimes[0].departure_time < currentBatch.endtime)) );
		   });

		   currentBatch.resolve(filtered);
		}
		else {
		   currentBatch.reject("No results found");
		}
    }

    function batchError(reason) {
         console.error("batchError: " + JSON.stringify(reason));
         currentBatch.reject(reason);
    }

      function objtoArray(obj)
      {
      	  result = [];
      	  var index = 0;
          for (item in obj)
          {
              result[index++] = obj[item];
          }
          return result;
      }
