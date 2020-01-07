

var raildata = {
      /*
           Search rail schedule for all trains that include keystation on dayid.

           keystation (required) : search only for trains that stop at station name
           dayid (required) : days from train travel:
           				M1 : Monday - Friday
           				M2 : Friday only
           				M3 : Saturday only
           				M4 : Sunday only
           				M5 : Monday - Thursday
           stationList (optional) : only include stops for station in this list, if not supplied all
                         station stops are include for each train.
           direction (optional) : inbound or outbound, if not supplied both inbound and outbound trains are returned.
           start (optional) : only include stops after this time
           stop (optional) : only include stop before this time

      */
     //baseUri : "http://localhost:2019/",
     //baseUri : "https://www.sarosi.net:2018/",
     //baseUri : "https://v70o5suh66.execute-api.us-east-2.amazonaws.com/raildata/",
     baseUri : "",
     dataversion : "",
   init: function(uri) {
      this.baseUri = uri;  // endpoint must be set
   },
   setDataVersion(version) {
      this.dataversion = version;
   },
	searchSchedule: function(keystation,dayid,stationList,direction,start,end) {
       if (keystation && dayid) {
  	      var uri = this.baseUri + "search?keystation=" + keystation;
  	      uri += "&dayid=" + dayid;
  	      if (stationList)
  	      	uri += "&stationlist=" + stationList;
  	      if (direction)
  	      	uri += "&direction=" + direction;
  	      if (start)
  	      	uri += "&start=" + start;
  	      if (end)
  	      	uri += "&end=" + end;
         if (this.dataversion)
            uri += "&dataversion=" + this.dataversion;

  	      var encodedUri = encodeURI(uri);

  		    return fetch(encodedUri).then(function(response) {
  			    return response.json();
  		    });
  	   }
	 },
	 getStations: function() {
        var uri = this.baseUri + "stations";
        if (this.dataversion)
           uri += "?dataversion=" + this.dataversion;

	     var encodedUri = encodeURI(uri);
		  return fetch(encodedUri).then(function(response) {
			   return response.json();
		  });
	 },
	 getCalendar: function() {
       var uri = this.baseUri + "calendar";
       if (this.dataversion)
          uri += "?dataversion=" + this.dataversion;

	    var encodedUri = encodeURI(uri);
		  return fetch(encodedUri).then(function(response) {
			   return response.json();
		  });
	 },
   getDataVersion: function() {
       var uri = this.baseUri + "dataversion";
       if (this.dataversion)
          uri += "?dataversion=" + this.dataversion;

	     var encodedUri = encodeURI(uri);
		   return fetch(encodedUri).then(function(response) {
          return (response.json())
       }).then(function(jsdata) {
          this.dataversion = jsdata.version;
			    return jsdata;
       });
	 },
	 getTrainStatus: function(trainnumber)
	 {
	     var uri = this.baseUri + "status?num=" + trainnumber;
       if (this.dataversion)
          uri += "&dataversion=" + this.dataversion;
	     return fetch(uri).then(function(response) {
	        return response.json();
	     });
	 }
}
