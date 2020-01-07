var util = require('util');
var promisify = require('promisify-node');
var https = require('https');
var http = require('http');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
var url = require('url');
var fetch = require('node-fetch');
var fs = promisify("fs");
var raildata = require('../../updateraildata/inmem/updateraildata.js');  /* Fix me */


const OUTBOUND = 1;
const INBOUND = 0;  /* seems that the septa values are reversed from the spec */
const UPDATE_DATA_INTERVAL = 86400000;  /* 24 hours */
//const UPDATE_DATA_INTERVAL = 120000;  /* 2 minutes */
var PORT;

const septaStatsUri = "https://www.septastats.com/api/current/train/$train_number$/latest";


var stopTimes;
var stations;
var trips;
var tripdays;
var caldays;
var dataEndDate;
var dataversion;
var staticMaxAge;
var headerRow;
//var scheduleDir = "mostrecent-rail";
var scheduleDir;

    if (process.env.RAIL_DATA_DIRECTORY != undefined) {
       scheduleDir = process.env.RAIL_DATA_DIRECTORY;
       console.log("Data directory set to: " + scheduleDir);
    }
    else {
      console.log("environment variable RAIL_DATA_DIRECTORY must be set")
      process.exit(-1);
    }

    //console.log(process.env.RAIL_SERVICE_PORT);
    start();

    function start()
    {
       console.log("[start]: Before loadrailData");
       //console.log(process.env.RAIL_SERVICE_PORT);

       raildata.checkForNewData().then(function(result) {
          console.log("[start]: checkForNewData result = " + result);

          //If checkForNewData resolves then the data exists so load data into memory
          return loadrailData();
       }).then(function(results) {
          console.log("[start]: " + results);
          configServer();
          startServer();
          startUpdateCheck();
       })
       .catch(function(result) {
          console.log("[start] " + result);
          process.exit(-1);
       })
    }

    function startServer()
    {
         //console.log(process.env.RAIL_SERVICE_PORT);

         /* Get the port from an environment variable */
         if (process.env.RAIL_SERVICE_PORT != undefined) {
            PORT = process.env.RAIL_SERVICE_PORT;
         }
         else {
            console.error("[startServer]: Error: RAIL_SERVICE_PORT must be set");
         }

         if ((process.env.RAIL_SERVICE_KEY != undefined) &&
             (process.env.RAIL_SERVICE_CERT != undefined)) {
             /* HTTPS */
             const options = {
                key: process.env.RAIL_SERVICE_KEY,
                cert: process.env.RAIL_SERVICE_CERT
             };
             console.log("[startServer]: SSL key and cert found, using HTTPS");
             server = https.createServer(options, handleRequest);
         }
         else    /* HTTP */
         {
             console.log("[startServer]: No SSL key and cert found, using HTTP");
             server = http.createServer(handleRequest);
         }

         server.listen(PORT, '::', function() {
            console.log("[startServer]: Server listening on port " + PORT);
         });
    }

    function handleRequest(request, response)
    {
      try {
          // Log request with date & time
          var d = new Date();
          console.log("[handleRequest " + d.toLocaleString() + " ]: " + request.url);

          if (dataEndDate != undefined) {
             /* calculate cache TTL (max-age) for all responses based on static data,
                we can make this to be the number of seconds from now until the date expires

                Is this a good idea? The schedule data should not change before the
                data end date.  But...it could if Septa made an unexpected schedule change.
                In this scenario, clients could possibily used cached data until it expires.
                Since this app is lightly used it would probably get kicked out of cache earlier, but
                not always.  If this happened you could do a cache invalidation.  But that only
                would work for CloudFront, not for client caches.  At this point I would probably
                need to add something to the API url, i.e. version or cache buster parameter, Which
                would require a client code modification

             */
             staticMaxAge = Math.floor((dataEndDate.getTime() - d.getTime()) / 1000);
             if (staticMaxAge < 0) staticMaxAge = 0;  // just in case
          }
          else {
             /* dataEndDate is undefined, so just set it to 0  */
             staticMaxAge = 0;
          }

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
          console.log("[handleRequest]: " + err);
      }
    }

    function configServer()
    {
       dispatcher.onGet("/search",function(req,res) {
			  var parsedUrl = url.parse(req.url,true);

           res.setHeader('Cache-Control','max-age=' + staticMaxAge);
	        res.writeHead(200, {'Content-Type': 'application/json'});
			  res.end(JSON.stringify(filtertraindata(parsedUrl.query.keystation,
				                       parsedUrl.query.stationlist.split(","),
				                       parsedUrl.query.dayid,
				                       (  parsedUrl.query.direction === undefined ? undefined :
				                          (parsedUrl.query.direction.toLowerCase() === "inbound" ? INBOUND : OUTBOUND)
				                       ),
				                       parsedUrl.query.start,parsedUrl.query.end)));
			 });

          /* use the data version which is a combination of the start_date and end_date
             from the calendar data.  The client should get this value at startup and then
             use it in the query string on every cachable API call (or just on every call).  This will work as
             a cache buster.  If the data is updated before the end_date, the version will change
             and thus since this version will be different it should bust the cache.
             The APIs will not look at or do anything with this value
          */
          dispatcher.onGet("/dataversion",function(req,res) {
             res.setHeader('Cache-Control','max-age=0');
             res.writeHead(200, {'Content-Type': 'application/json'});
			    res.end(JSON.stringify({version: dataversion}));
          });

          dispatcher.onGet("/headers",function(req,res) {
             res.setHeader('Cache-Control','max-age=0');
             res.writeHead(200, {'Content-Type': 'application/json'});
			    res.end(JSON.stringify(req.headers));
          });

			 dispatcher.onGet("/stations",function(req,res) {
             res.setHeader('Cache-Control','max-age=' + staticMaxAge);
	          res.writeHead(200, {'Content-Type': 'application/json'});
			    res.end(JSON.stringify(objtoArray(stations)));
			 });

			 dispatcher.onGet("/calendar",function(req,res) {
             console.log("[/calendar]: end_date: " + caldays.M1.end_date);
             res.setHeader('Cache-Control','max-age=' + staticMaxAge);
	          res.writeHead(200, {'Content-Type': 'application/json'});
			    res.end(JSON.stringify(objtoArray(caldays)));
			 });

			 dispatcher.onGet("/status", function(req,res) {
		      var parsedUrl = url.parse(req.url,true);
			   var trainnum = parsedUrl.query.num;

                if (trainnum != undefined) {
				       var uri = septaStatsUri.replace("$train_number$",trainnum);
				       console.log("[/status]: status uri: " + uri);
				       fetch(uri).then(function(response) {
				       return response.text();
				     }).then(function(text) {
				       console.log(text);
                   res.setHeader('Cache-Control','max-age=0');
				       res.writeHead(200, {'Content-Type': 'application/json'});
                   res.end(text);
				     }).catch(function(reason) {
				       console.log("[/status]: Error getting status: " + reason);
                   res.writeHead(500, {'Content-Type': 'application/json'});
                   res.end(JSON.stringify({message: "Error: " + reason}));
				     });
			      }
			      else {
	              res.writeHead(400, {'Content-Type': 'application/json'});
			    	  res.end(JSON.stringify({message: "Error: train number must be valid"}));
			      }
			 });
      }

      function startUpdateCheck()
      {
          setInterval(function updateCheck() {
             var now = new Date();

             raildata.checkForNewData().then(function(result) {
                console.log("\n[updateCheck " + now.toLocaleString() + "]: checkForNewData result = " + result);

                if (result === "Update") {
                   return loadrailData();
                }
                return result;
             }).then(function(results) {
                console.log("[updateCheck]: " + results);
             }).catch(function(result) {
                //Data update failed, should we do more?
                console.log("[updateCheck] " + result);
             });
          },UPDATE_DATA_INTERVAL);
      }

    function loadrailData()
    {
      return new Promise(function(resolve, reject) {
         console.log("[loadrailData]: reading " + scheduleDir + "/stop_times.txt");
			   getcsv(scheduleDir + "/stop_times.txt",true).then(function(results) {
			   stopTimes = results;
			   console.log("reading " + scheduleDir + "/stops.txt");
			   return getcsv(scheduleDir + "/stops.txt",true,"stop_id");
			})
			.then(function(sts) {
			   stations = sts;
			   console.log("[loadrailData]: reading " + scheduleDir + "/trips.txt");
			   return getcsv(scheduleDir + "/trips.txt",true,"trip_id");
			})
			.then(function(trps) {
			   trips = trps;
			   console.log("[loadrailData]: reading " + scheduleDir + "/calendar.txt");
			   return getcsv(scheduleDir + "/calendar.txt",true,"service_id");
			})
			.then(function(tdays) {
			   caldays = tdays;
            dataversion = caldays.M1.start_date.trim() + caldays.M1.end_date.trim();  /* use the start and end date as the data version */
            dataEndDate = convertDate(caldays.M1.end_date);
			      console.log("[loadrailData]: Rail data reading complete");
            if (dataEndDate != undefined) {
               console.log("[loadrailData]: Data End Date: " + dataEndDate.toLocaleString());
            }
            else {
               console.log("[loadrailData]: Data End Date: undefined");
            }

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

			   resolve("Rail data loaded");

			})
			.catch(function(err) {
			   console.log("Error reading data:" + err);

			   reject("Error reading rail data " + err);
			});
		});
    }

      function findStations(stationNames)
      {
         var station_ids = [];
         var i = 0;

         stationNames.forEach( function(name) {
             for (station_id in stations) {
                if (stations[station_id].stop_name == name) {
                	 station_ids[i++] = station_id;
                	 break;
                }
             }
         });
         return(station_ids);
      }


      /*
           As it turns out a "trip" is not a good collection of stops because inbound trips
           seems to change over between lines at 30th St.

           What I need to do:
                - search the list of stop times to find all stop times that stop at the local station
                  that I care about (i.e. Berwyn)
                - use that list to find the trips that meet the day and direction that I care about,
                  i.e. (M-F) inbound and (M-F) outbound
                - extract a list of unique train numbers from this list of trips
                - for each train, find the stops that I care about and build a list of stops and times.

           *** This is really, really slow.  How do I fix it? ***

            *** New version that relies on building the tripdays array ***

      */

      function filtertraindata(station,stationList,dayid,direction,starttime,endtime)
      {
         var results = [];
         var rIndex = 0;
         var start1 = new Date().getTime();

         if (dayid === undefined || station === undefined) {
         	 return [];
         }

         for (train in tripdays[dayid].trains) {
         /*
             console.log("station: " + station);
             console.log("direction: " + direction);
             console.log("train.direction_id: " + JSON.stringify(tripdays[dayid].trains[train]));
             console.log("train.stops[station]: " + tripdays[dayid].trains[train].stops[station]);
             */
             /* if the current train is going the correct direction and the key "station"
                is in it's list of stops, include it in the list */
             if ((direction === undefined || tripdays[dayid].trains[train].direction == direction) &&
                 tripdays[dayid].trains[train].stops[station] != undefined) {
                 var ts = new Object();
         	       ts.trainnum = tripdays[dayid].trains[train].trainnum;

           	     if (stationList) {
           	     	 var stIndex = 0;
           	     	 ts.stoptimes = [];
           	         stationList.forEach(function(stn) {
          					    if (tripdays[dayid].trains[train].stops[stn] != undefined) {
          						    ts.stoptimes[stIndex++] = Object.assign({},tripdays[dayid].trains[train].stops[stn], {
          						      stop_name: stations[stn].stop_name
          						    });
  						         }
  					        });
  				       }
  				       else {
  				          /* convert to array */
  				          ts.stoptimes = objtoArray(tripdays[dayid].trains[train].stops);
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
             }
         }

         if (results.length > 0) console.log("search results[0]: " + results[0].trainnum);
         var filtered = results.sort(function (a,b) {
             if (a.stoptimes[0].departure_time < b.stoptimes[0].departure_time) {
                return (-1);
             } else if (a.stoptimes[0].departure_time > b.stoptimes[0].departure_time) {
                return (1);
             } else {
                return (0);
             }
         }).filter(function (t) {
            return ( ((starttime === undefined) || (t.stoptimes[0].departure_time > starttime)) &&
                     ((endtime === undefined) || (t.stoptimes[0].departure_time < endtime)) );
         });

         return(filtered);
      }

      function objtoArray(obj)
      {
      	 result = [];
      	 var index = 0;
          for (item in obj) {
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

      function inTrip(trip_id, stationList)
      {
           /* get stops in trip */
           var trip = stopTimes.filter( function(stop) { return( (stop.trip_id == trip_id) );} );

           var bContains = true;
           stationList.forEach( function(station) {
              bContains = (bContains && (trip.findIndex(function(stop) {return (station == stop.stop_id);}) > -1));
           });

           return(bContains);
      }

      function gettrain(tripid)
      {
      	  //console.log("tripid: " + tripid);
          return ( trips.find(function(trip) { return(trip.trip_id == tripid);}).block_id);
      }


 	function getcsv(path,hr,headerIndexStr) {
	   if (path) {
		   return fs.readFile(path,'utf8').then(function(data) {
		      console.log("[getcsv]: path: " + path);
			    return csvparse(data,hr,headerIndexStr);
		   })
		   .catch(function() {
		      console.log("[getcsv]: Error reading " + path);
		   });
	   }
	}


	function csvparse(csvdata,headerRow,headIndexLabel)
	{
		if (csvdata) {
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
           var bEmptyWarn = false;
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
                        if (!bEmptyWarn) console.log("[csvparse(line num " + rindex + ")]: Empty Value for " + fieldname);
                        value = "empty";
                        bEmptyWarn = true;
                     }
                     lineObj[fieldname] = value;
					   });
					   //console.log(lineObj);
					   if (headers && headerIndex > -1) {
                     results[values[headerIndex]] = lineObj;  /* this is key, use the headerIndex value as the object attribute Name
                                                                 allows for a much quicker access of the data */
					   }
					   else	{
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
