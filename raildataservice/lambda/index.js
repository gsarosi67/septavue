var fetch = require('node-fetch');
var AWS = require('aws-sdk');
const septaStatsUri = "https://www.septastats.com/api/current/train/$train_number$/latest";
var docClient;
var currentBatch;
var dataEndDate;
var dataversion;

const OUTBOUND = 1;
const INBOUND = 0;  /* seems that the septa values are reversed from the spec */
const BATCH_REQUEST_MAX = 10;

    if (process.env.RAIL_SERVICE_LOCAL != undefined) {
        var url = require('url');
        var levent = {};
        var i = 1;
    		while (i < process.argv.length) {
    			if (process.argv[i] == "-path") {
    				levent.path = process.argv[++i];
    			}
    			else if (process.argv[i] == "-query") {
    			    levent.queryStringParameters = url.parse(process.argv[++i],true).query;
    			}
    			i++;
    		}

    		if (levent.path != undefined)
    		{
    		   console.log("levent: " + JSON.stringify(levent));
    		   handler(levent, null, function(event,response) {
    		          console.log("Response: " + JSON.stringify(response));
    		   });
    		}
    		else {
    		   console.error("Path undefined");
    		}
    }

    //function handler(event, context, callback) {
    exports.handler = (event, context, callback) => {
        var d = new Date();
        var q;

        if (process.env.RAIL_SERVICE_LOCAL != undefined) {
           AWS.config.update({region:'us-east-2',endpoint: 'http://localhost:8000'});
        }
        else {
           AWS.config.update({region:'us-east-2'});
        }

        docClient = new AWS.DynamoDB.DocumentClient();

        console.log(d.toLocaleString() + " : " + event.resource + event.path);
        if (event.queryStringParameters != undefined) {
      	   console.log("queryStringParameters: ");
      	   console.log(JSON.stringify(event.queryStringParameters));
      	   q = event.queryStringParameters;
        }

        /* First retrieve the 'Calendar' table to get the data start and end dates */
        getTable('Calendar',q,'OBJECT', function(err, caldays) {
           if (!err) {
              dataversion = caldays[0].start_date.trim() + caldays[0].end_date.trim();  /* use the start and end date as the data version */
              dataEndDate = convertDate(caldays[0].end_date);
           }
           else {
              console.log("Error retrieving calendar table no dataversion or EndDate set");
           }

           switch (event.path)
           {
               case "/search":
                  search(q,callback);
               break;

               case "/dataversion":
                  if (dataversion != undefined) {
                     callback(null,prepareresponse(200,'NO_CACHE',JSON.stringify({version: dataversion})));
                  }
                  else {
                     callback(null,prepareresponse(500,'NO_CACHE',JSON.stringify({message: err.message})));
                  }
               break;

               case "/calendar":
                  //getTable('Calendar',q,callback);
                  if (caldays != undefined) {
                    callback(null,prepareresponse(200,'DATA_EXPIRE',JSON.stringify(caldays)));
                 }
                  else {
                    callback(null,prepareresponse(500,'NO_CACHE',JSON.stringify({message: err.message})));
                  }
               break;

               case "/stations":
                  getTable('Stations',q,'HTTP_RESPONSE',callback);
               break;

               case "/status":
                  status(q,callback);
               break;
           }
        });
    };

    function search(query,cb)
    {
		 if ((query != undefined) &&
			(query.keystation != undefined) &&
			(query.stationlist != undefined) &&
			(query.dayid != undefined) &&
			(query.direction != undefined) &&
			(query.start != undefined) &&
			(query.end != undefined))
		 {
			findtraindata(query.keystation,
						  query.stationlist.split(","),
						  query.dayid,
						  ( query.direction === undefined ? undefined :
							(query.direction.toLowerCase() === "inbound" ? INBOUND : OUTBOUND)
						  ),
						  query.start,query.end)
			.then(function (results) {
				//console.log("results: " + JSON.stringify(results));
				console.log("Search Complete: result length: " + results.length);
				cb(null,prepareresponse(200,'DATA_EXPIRE',JSON.stringify(results)));
			}).catch(function(reason) {
				console.log("Search Error: " + JSON.stringify(reason));
				cb(null,prepareresponse(500,'NO_CACHE',JSON.stringify({message: "Search Error: " +  JSON.stringify(reason)})));
			});
		 }
		 else {
		     /* return error */
			 console.log("Error: Search parameters missing");
			 cb(null,prepareresponse(400,'NO_CACHE',JSON.stringify({message: "Search parameters missing"})));
		 }
    }

    function getTable(tablename,query,type,cb)
    {
        var response;

    	  docClient.scan({TableName: tablename},function(err,data) {
           if (type == 'HTTP_RESPONSE') {
    			  if (!err) {
                response = prepareresponse(200,'DATA_EXPIRE',JSON.stringify(data.Items));
    			  }
    			  else {
                response = prepareresponse(500,'NO_CACHE',JSON.stringify({message: err.message}));
    			  }
    			  console.log("Response: " + JSON.stringify(response));
    			  cb(null,response);
           }
           else if (type == 'OBJECT') {
              /* HANDLE error case */
              if (!err) {
                cb(null,data.Items);
              }
              else {
                cb(err);
              }
           }
    	  });
    }

    function status(query,cb)
    {
    		if ((query != undefined) &&
    		   (query.num != undefined)) {
    			var uri = septaStatsUri.replace("$train_number$",query.num);
    			console.log("status uri: " + uri);
    			fetch(uri).then(function(response) {
    				return response.text();  // Response implements Body so this is a method that returns a promise!!
    			}).then(function(text) {
    				console.log(text);
    				cb(null,prepareresponse(200,'NO_CACHE',text));
    			}).catch(function(reason) {
    				console.log("Error getting status: " + reason);
    				cb(null,prepareresponse(500,'NO_CACHE',JSON.stringify({message: "Error: " + reason})));
    			});
    		}
    		else {
    			console.log("Error: status requires num parameter");
    			cb(null,prepareresponse(400,'NO_CACHE',JSON.stringify({message: "Error: status requires num parameter"})));
    		}
    }

    function prepareresponse(httpstatus,expType,data)
    {
        var d = new Date();
        var expires = 0;
        if (expType == 'DATA_EXPIRE') {
           if (dataEndDate != undefined) {
              expires = Math.floor((dataEndDate.getTime() - d.getTime()) / 1000);
              if (expires < 0) expires = 0;  // just in case
           }
        }
        var response =
        {
           isBase64Encoded: false,
           headers: {
             'Content-Type' : 'application/json',
             'Access-Control-Allow-Origin' : '*',
             'Cache-Control' : 'max-age=' + expires  // 24 hours
           },
           statusCode: httpstatus,
           body: data
        };
        return(response);
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
					   };

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
			   currentBatch.batchComplete();
			}
			else {
				 /* send next batch request */
			   currentBatch.start = currentBatch.next;
			   currentBatch.num = Math.min(BATCH_REQUEST_MAX,(currentBatch.sourcedata.length-currentBatch.start));
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
      	  var result = [];
      	  var index = 0;
          for (var item in obj)
          {
              result[index++] = obj[item];
          }
          return result;
    }

    /* Assumes date string in the raildata format:
     <year><month><date>
     i.e.  20181117
    */
    function convertDate(dateString) {
       if (dateString != undefined) {
         var ds = dateString.trim();
         console.log("[convertDate]: dateString= " + ds + " length=" + ds.length);
         if (ds.length == 8) {
            return (new Date(parseInt(ds.substr(0,4)),        //year
                             parseInt(ds.substr(4,2))-1,        //month (must be zero based)
                             parseInt(ds.substr(6,2))));      //date
         }
       }
       return(undefined);
    }
