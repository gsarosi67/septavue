	/*
	   ToDo:
         - right justify times
         - investigate train times that go into a new day, past 12:00am, not working
         - add key handling for X1, test on X1
		   - find closest station
		   - add about with instructions
		   - fix the css, too many classes
		   - test on iPhone and other browsers
		   - figure out if a train is express or local (belongs in raildata)
		   - additional error handling
	*/
  var bDebug = false;
  var dbg;
  var unselectedColor = 'black';
  var selectedColor = 'rgb(20,200,50)';

  /* don't set the watch until after we have setDefaults */
  var watch = {
		keystation : _.debounce(function() {
			this.fetchData()
			this.storeLocalData('keystation',this.keystation)
		},100),
		stationList : _.debounce(function() {
			this.fetchData()
			this.storeLocalData('stationlist',this.stationList.toString())
		},100),
		direction : _.debounce(function() {
			this.fetchData()
		},100),
		dayid : _.debounce(function() {
			this.fetchData()
		},100),
		/* _.debounce is a function provided by lodash to limit how
		   often a particularly expensive operation can be run.
		   when changing the time, give the user 500ms to settle on a time
		   before fetching new data */
		starttime : _.debounce(function() {
			this.fetchData()
		},500),
		endtime : _.debounce(function() {
			this.fetchData()
		},500),
		currentAnchor : function() {
		    this.changeFocus()
		}
	};

  var trainvue = new Vue({
	 el: '#trainvue',
	 data: {
		trains : [],
		stations : null,

    /* initial values for direction, starttime and endtime should be set based on the current time of day
			Formatting for the time is important
			Train data uses military time
		 */
		direction : 'Inbound',
		starttime : '05:00:00',
		endtime : '12:00:00',
		stationList : ["Berwyn","Devon","Suburban Station"],
		keystation : "Berwyn",
		dayid : "M1",
		controlson : false,
		fetchcount : 0,
		currenttime : "00:00:00 am",
		calendar : [],
		anchors : [],
      anchordivs : [],
		currentAnchor : -1,
		currentAnchor : -1,
		lastsearchStart : 0,
		lastsearchEnd : 0,
		lastsearchDuration : 0,
      bMapReady : false,
      dataversion : '0'
	 },
	 created: function () {
	     document.addEventListener('keydown', this.keyDown, false) //feels wrong
	     //toggleDebug()
        this.initData()
        this.getDataVersion()
	      this.startClock()
		    this.getStations()   //calls setDefaults() when finished, setDefaults calls fetchData()  ? Should I use a promise ?
		    this.getCalendar()
	 },
	 methods: {
		stopName: function(stop_id) {
			 return(this.stations.find(function(station) {
				 return (station.stop_id === stop_id)
			 }).stop_name)
		},
		stopId: function(stop_name) {
			 return(this.stations.find(function(station) {
				 return (station.stop_name === stop_name)
			 }).stop_id)
		},
		stopIdlist: function(namelist) {
		    var results = []
		    var self = this
		    namelist.forEach(function (name) {
		      results.push(self.stopId(name))
		    });
		    return(results)
		},
		fetchData: function () {
		   this.fetchcount++
		   console.log("Fetching data, count = " + this.fetchcount);
		   var self = this
		   if (performance != undefined && performance.now != undefined) {
		      self.lastsearchStart = performance.now()
		   }
		   raildata.searchSchedule(this.stopId(this.keystation),this.dayid,this.stopIdlist(this.stationList).toString(),
		                           this.direction,this.starttime,this.endtime).then(function(results) {
		       if (performance != undefined && performance.now != undefined) {
		          self.lastsearchEnd = performance.now()
		          self.lastsearchDuration = self.lastsearchEnd - self.lastsearchStart
		       }

			   self.trains = results
			   if (!self.controlson) {
				   Vue.nextTick(function() {
					   /* get list of trainentries for remote control navigation
							should I be using vm.$el???
					   */
					   self.anchordivs = Array.prototype.slice.call(document.getElementsByClassName('trainentry'))
						self.anchors = Array.prototype.slice.call(document.getElementsByTagName('a'))
			         self.currentStatus()
				   })
			   }
		   })
		},
		getStations: function () {
		   var self = this
		   raildata.getStations().then(function(results) {
			   self.stations = results.sort(function(a,b) {
				  if (a.stop_name < b.stop_name) {
					 return -1;
				  } else if(a.stop_name > b.stop_name) {
					 return 1;
				  } else {
					 return 0;
				  }
			   })

			   self.setDefaults()   // don't wait to call this until after the stations are loaded

		   })
		},
		/* todo: figure out a method to use this populate the dayid dialog */
		getCalendar: function () {
		   var self = this
		   raildata.getCalendar().then(function(results) {
			   self.calendar = results
		   })
		},
      getDataVersion: function () {
         var self = this
         raildata.getDataVersion().then(function(results) {
            if (results.version != self.dataversion) {
               self.dataversion = results.version
               self.storeLocalData('dataversion',self.dataversion)
               self.getStations()  /* I don't like how this is structured */
            }
         })
      },
		getStatus: function (trainnum) {
		   var self = this
		   raildata.getTrainStatus(trainnum).then(function(results) {
			  var trainIdx = self.trains.findIndex(function(tr) {
				 return(trainnum === tr.trainnum)
			  })
			  if (trainIdx > -1)
			  {
				  /* results can be empty!  what to do? */
				  if (results.data.length > 0) {
					  Vue.set(self.trains[trainIdx],'nextStop',results.data[0].nextstop)
					  Vue.set(self.trains[trainIdx],'late',results.data[0].late)
					  Vue.set(self.trains[trainIdx],'lat',parseFloat(results.data[0].lat))
					  Vue.set(self.trains[trainIdx],'lon',parseFloat(results.data[0].lon))
                 Vue.nextTick(function() {
                   if (self.bMapReady) {
                  /*
    					     Vue.set(self.trains[trainIdx],'mapUrl',self.mapUrl.replace(/latitude/g,results.data[0].lat)
    																				  .replace(/longitude/g,results.data[0].lon))
                  */
                     console.log("Creating Map")
                     Vue.set(self.trains[trainIdx],'map',
                        new google.maps.Map(document.getElementById('map'+trainnum), {
                           center: {lat: self.trains[trainIdx].lat, lng: self.trains[trainIdx].lon},
                           zoom: 14,
                           zoomControl: true,
                           mapTypeControl: false,
                           fullscreenControl: false,
                           streetViewControl: false
                        })
                     )
                     Vue.set(self.trains[trainIdx],'marker',
                        new google.maps.Marker({
                           position: {lat: self.trains[trainIdx].lat, lng: self.trains[trainIdx].lon},
                           map: self.trains[trainIdx].map,
                           title: trainnum,
                           icon: 'train-public-transport.png'
                        })
                     )
                   }
                 })
				  }
				  else {
					  Vue.set(self.trains[trainIdx],'nextStop','Unknown');
					  Vue.set(self.trains[trainIdx],'late','Unknown');
				  }
			   }
		   })
		},
      startClock: function() {
		   var self = this
		   setInterval(function() {
              var now = new Date();
              var clock = self.pad(now.getHours(),2) + ":" +
                          self.pad(now.getMinutes(),2) + ":" +
                          self.pad(now.getSeconds(),2)
              self.currenttime = self.time24to12(clock);

   		   }, 1000)
   		},
      pad: function(number, size) {
		   number = number.toString()
		   while (number.length < size) number = "0" + number
		   return number
      },
      setDefaults: function() {
		   var d = new Date();

		   /* set the direction and start and end times based on current times */
		   if (d.getHours() <= 12)
		   {
			   /* before noon, assume inbound morning trains */
			   this.direction = 'Inbound'
		   }
		   else
		   {
			   /* after noon, assume outbound morning trains */
			   this.direction = 'Outbound'
		   }
		   /* set the initial start and end time based on the current hour */
		   var s = Math.max(5,(d.getHours()-1));
		   this.starttime = ((s < 10) ? '0' : '') + s + ':00:00';
		   var e = Math.min(23,(d.getHours()+4));
		   this.endtime = ((e < 10) ? '0' : '') + e + ':00:00';

		   /* If Saturday or Sunday set the dayid to the correct day, otherwise
			  set it for Monday - Friday */
		   if (d.getDay() == 0) {
			   /* Sunday */
			   this.dayid = 'M4'
		   }
		   else if (d.getDay() == 6) {
			   /* Saturday */
			   this.dayid = 'M3'
		   }
		   else {
			   this.dayid = 'M1'
		   }

		   /* see if the key station and station list is stored locally */
		   if (this.getLocalData('keystation') != null) {
		      this.keystation = this.getLocalData('keystation')
		   }

		   if (this.getLocalData('stationlist') != null) {
		      this.stationList = this.getLocalData('stationlist').split(/,/)
		   }

		   for (prop in watch) {
		       this.$watch(prop,watch[prop]);
		   }

         this.fetchData();
      },
      initData: function() {
         var mode = "lambda"
         var query = document.URL.slice(document.URL.indexOf("?")+1)
         if (query) {
            var params = query.split("&")
            for (var i = 0; i < params.length; i++) {
               var equal = params[i].indexOf("=")
               if (params[i].substring(0,equal) == "mode") {
                  mode = params[i].substring(equal+1)
               }
               else if (params[i].substring(0,equal) == "debug") {
                  if (!bDebug)
                      toggleDebug()
               }
               else if (params[i].substring(0,equal) == "nodebug") {
                  if (bDebug)
                     toggleDebug()
               }
            }
         }
         switch (mode.toLowerCase()) {
           case "lambda":
           case "dyno":
              raildata.init("https://v70o5suh66.execute-api.us-east-2.amazonaws.com/raildata/")
           break;
           case "inmem":
              raildata.init("https://services.sarosi.net:2018/")
           break;
           case "local":
              raildata.init("http://localhost:2018/")
           break;
           default:
              raildata.init("https://v70o5suh66.execute-api.us-east-2.amazonaws.com/raildata/")
         }
         if (this.getLocalData('dataversion') != null) {
            this.dataversion = this.getLocalData('dataversion')
            raildata.setDataVersion(this.dataversion)
         }
      },
		storeLocalData: function(key,value) {
		    if (window.localStorage) {
		        try {
		           window.localStorage.setItem(key,value)
		        }
		        catch (e) {
		           console.log("Error storing local data - key: " + key + " value: " + value)
		        }
		    }
		},
		getLocalData: function(key) {
		    if (window.localStorage) {
		        try {
		           return (window.localStorage.getItem(key))
		        }
		        catch (e) {
		           console.log("Error retrieving data from local storage - key: " + key)
		           return(null)
		        }
		    }
		},
		toggleControl: function() {
		    var self = this
		    this.currentAnchor = -1    // Need this to undraw the select border
		    this.controlson = !this.controlson

		    Vue.nextTick(function() {
		       if (self.controlson) {
		          /* control from is open, change anchor list to the items in control */
		          var controls = document.getElementsByClassName('controls')[0]
		          var selects = Array.prototype.slice.call(controls.getElementsByTagName('select'))
		          var inputs = Array.prototype.slice.call(controls.getElementsByTagName('input'))

		          /* this doesn't really work...the navigation is shit.   only needed
		             for the stb platform, what is the right solution?? */
		          //self.anchors = selects.concat(inputs)
		          //self.currentAnchor = 0
		       }
		       else {
		          /* back to the list, but if any of the control values changed, the anchor list will
		            be generated by fetchdata.
		          */
				      //self.anchors = Array.prototype.slice.call(document.getElementsByClassName('trainentry'))
				      //self.currentStatus()
		       }
		    })
		},
		currentStatus: function() {
		   if (this.trains != undefined) {
			  var self = this
			  var d = new Date()
			  var icount = 0
			  var ctime = self.pad(d.getHours(),2) + ":" + self.pad(d.getMinutes(),2) + ":" + self.pad(d.getSeconds(),2)

			  this.trains.forEach(function(train,index) {
				 if (train.stoptimes != undefined)  {
				   //printDbgMessage("depart time: " + train.stoptimes[0].departure_time + "   ctime: " + ctime);
				   if (train.stoptimes[0].departure_time >= ctime && icount < 3) {
				      /* get the first index */
				      if (icount === 0) {
				         self.previousAnchor = self.currentAnchor
				         self.currentAnchor = index
	               }
					   self.getStatus(train.trainnum)
					   icount++
				   }
				 }
			  })
		   }
		},
		time24to12: function(time) {
		   /* convert hours to 12 hour format */
		   if (time) {
			  var cindex1 = time.indexOf(":")

			  var hour = time.slice(0,cindex1)
			  var ampm
			  if (hour > 12) {
				 hour = hour - 12
				 ampm = "pm"
			  }
			  else if (hour == 12) {
				 hour = parseInt(hour)
				 ampm = "pm"
			  }
			  else {
				 hour = parseInt(hour)
				 ampm = "am"
			  }

			  return(hour + ":" + time.slice(cindex1+1) + " " + ampm)
		   }
		},
		keyDown: function(event) {

    	   var EKC = event.keyCode;

    	   printDbgMessage("keyCode= " + EKC);

    	   switch (EKC)
           {
				 case 13: /* Enter or Select */

                 /*  Does not work! I think the element needs to
                    be an actual anchor element, duh... */

				    this.anchors[this.currentAnchor].click();
				 break

				 case 37: /* Left arrow */
				    this.previousAnchor = this.currentAnchor
					this.currentAnchor--
					if (this.currentAnchor < 0) {
					   this.currentAnchor = this.anchors.length - 1
					}
				 break

				 case 38: /* Up arrow */
				    this.previousAnchor = this.currentAnchor
					this.currentAnchor -= calcrowsize(this.anchordivs)
					if (this.currentAnchor < 0) {
					   this.currentAnchor = this.anchors.length - 1
					}
				 break

				 case 39: /* Right arrow */
				    this.previousAnchor = this.currentAnchor
					this.currentAnchor++
					if (this.currentAnchor == this.anchors.length) {
					   this.currentAnchor = 0
					}
				 break

				 case 40: /* Down arrow */
				    this.previousAnchor = this.currentAnchor
					this.currentAnchor += calcrowsize(this.anchordivs)
					if (this.currentAnchor >= this.anchors.length) {
					   this.currentAnchor = 0
					}
				 break

				 case 48:  /* 0 digit key */
					toggleDebug()
				 break

				 case 404: /* xfinity B button */
				 case 66:  /* 'B' key on keyboard */
					document.getElementsByClassName('button1')[0].click()
				 break;

           }
        },
	     changeFocus: function() {
	        if (this.anchordivs.length > 0) {
			    var self = this
			    if (this.previousAnchor > -1) this.anchordivs[this.previousAnchor].style.outlineColor=unselectedColor
			    if (this.currentAnchor > -1) {
			       //this.anchors[this.currentAnchor].focus()
			       this.anchordivs[this.currentAnchor].style.outlineColor=selectedColor
			       Vue.nextTick(function() {
			          self.scrollTocurrent()
			       })
			    }
			  }
	     },
	     scrollTocurrent: function() {
	       /*
		   var grid = document.getElementsByClassName('traingrid')
		   if (grid != undefined && this.anchors.length > 0) {

		          I don't like this.  I want to scroll only the grid but setting
		          scrollTop does not work.  It only works for the html element...why?

		          There must be a more vue.js way to do this...

		   */
		   var htmlview = document.getElementsByTagName('html')
		   if (htmlview != undefined && this.anchors.length > 0) {
		       if (this.currentAnchor === 0) {
		          htmlview[0].scrollTop = 0
		       }
		       else if (this.anchors[this.currentAnchor].getBoundingClientRect().bottom > window.innerHeight) {
		          /* Scroll Up */
			      htmlview[0].scrollTop += (this.anchors[this.currentAnchor].getBoundingClientRect().bottom - window.innerHeight)
			   }
			   else if (this.anchors[this.currentAnchor].getBoundingClientRect().top < 0) {
			      /* scroll down */
			      htmlview[0].scrollTop -= Math.abs(this.anchors[this.currentAnchor].getBoundingClientRect().top)
			   }
		   }
     },
     initMap: function() {
         this.bMapReady = true
     }
	 }
  })

   function toggleDebug() {
    	dbg = document.getElementById("debug");
        if (!bDebug) {
            /* Enable Debug window */
            bDebug = true;
            dbg.style.display = "inline";
            printDbgMessage("Debug On");
        }
        else {
            /* Disable Debug Window */
            bDebug = false;
            dbg.style.display = "none";
        }
   }

   function printDbgMessage(msg) {
		if (bDebug) {
			if (dbg != undefined) dbg.innerHTML = dbg.innerHTML + msg + "</br>" ;
			console.log(msg);

			/* try to auto scroll */
			if (dbg != undefined) {
				if (dbg.scrollHeight > dbg.clientHeight) {
					dbg.scrollTop = (dbg.scrollHeight - dbg.clientHeight);
				}
			}
		}
	}

    function calcrowsize(anchors) {
	    var rows = new Array();
	    var rownum = 0;
	    var i = 0;

	    var curY = anchors[i].getBoundingClientRect().top;
	    rows[0] = 0;
	    while (i < anchors.length) {
		    if (anchors[i].getBoundingClientRect().top > curY) {
			   rownum++;
			   rows[rownum] = 0;
		    }
		    rows[rownum]++;
		    i++;
	    }
	    return(rows[0]);
    }
