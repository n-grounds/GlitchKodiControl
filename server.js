// server.js
// where your node app starts

// init project
require('dotenv').load();
var express = require('express');
var app = express();

var Fuse = require('fuse.js')
var Kodi = require('./kodi-connection/node.js');
var kodi = new Kodi(process.env.KODI_IP, process.env.KODI_PORT, process.env.KODI_USER, process.env.KODI_PASSWORD);

// Set option for fuzzy search
var fuzzySearchOptions = {
  caseSensitive: false, // Don't care about case whenever we're searching titles by speech
  includeScore: false, // Don't need the score, the first item has the highest probability
  shouldSort: true, // Should be true, since we want result[0] to be the item with the highest probability
  threshold: 0.4, // 0 = perfect match, 1 = match all..
  location: 0,
  distance: 100,
  maxPatternLength: 64,
  keys: ['label']
}

app.use(express.static('public'));

var validateRequest = function(req, res, processRequest){
  var jsonString = '';
  var requestToken = '';
  var jsonBody;

  if (req == null || req.query == req) {
    console.log("403 - Unauthorized request");
    res.sendStatus(403);
    return;
  }
  
  req.on('data', function (data) {
    jsonString += data;
  });
  req.on('end', function () {
    if (jsonString != '') {
      jsonBody = JSON.parse(jsonString);
      if (jsonBody != null) {
        requestToken = jsonBody['token'];
        console.log("Request token = " + requestToken);
        if (requestToken == process.env.AUTH_TOKEN) {
          console.log("Authentication succeeded");
          processRequest(req, res);
          return;
        }
      }
    }
    console.log("401 - Authentication failed");
    res.sendStatus(401);
  });
};

// Pause or Resume video player
app.get("/playpause", function (request, response) {
  validateRequest(request, response, kodiPlayPause)
});

var kodiPlayPause = function(request, response) {
  console.log("Play/Pause request received");
  kodi.Player.PlayPause({playerid:1});
  response.sendStatus(200);
};

// Stop video player
app.get("/stop", function (request, response) {
  validateRequest(request, response, kodiStop)
});

var kodiStop = function(request, response) {
  console.log("Stop request received");
  kodi.Player.Stop({playerid:1});
  response.sendStatus(200);
};

// mute or unmute kodi
app.get("/mute", function (request, response) {
  validateRequest(request, response, kodiMuteToggle)
});

var kodiMuteToggle = function(request, response) {
  console.log("mute/unmute request received");
  kodi.Application.SetMute({"mute":"toggle"});
  response.sendStatus(200);
};

// set kodi volume
app.get("/volume", function (request, response) {
  validateRequest(request, response, kodiSetVolume)
});

var kodiSetVolume = function(request, response) {
  var setVolume = request.query.q.trim();
  console.log("set volume to \"" + setVolume + "\" percent request received");
  kodi.Application.SetVolume({"volume":parseInt(setVolume)});
  response.sendStatus(200);
};


// Turn on TV and Switch to Kodi's HDMI input
app.get("/activatetv", function (request, response) {
  validateRequest(request, response, kodiActivateTv)
});

var kodiActivateTv = function(request, response) {
  console.log("Activate TV request received");

  var params = {
          addonid: "script.json-cec",
          params: {
            command: "activate"
          }
        };
  kodi.Addons.ExecuteAddon(params);
};

var tryActivateTv = function() {
  if (process.env.ACTIVATE_TV != null && process.env.ACTIVATE_TV == "true") {
    console.log("Activating TV first..");
    kodiActivateTv(null, null);
  }
};


// Parse request to watch a movie
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/playmovie?q=[MOVIE_NAME]
app.get("/playmovie", function (request, response) {
  validateRequest(request, response, kodiPlayMovie)
});

var kodiPlayMovie = function(request, response) {
  tryActivateTv();
  
  var movieTitle = request.query.q.trim();
  console.log("Movie request received to play \"" + movieTitle + "\"");
    
  kodi.VideoLibrary.GetMovies()
  .then(function(movies) {
    if(!(movies && movies.result && movies.result.movies && movies.result.movies.length > 0)) {
      throw new Error('no results');
    }

    // Create the fuzzy search object
    var fuse = new Fuse(movies.result.movies, fuzzySearchOptions)
    var searchResult = fuse.search(movieTitle)

    // If there's a result
    if (searchResult.length > 0) {
      var movieFound = searchResult[0];
      console.log("Found movie \"" + movieFound.label + "\" (" + movieFound.movieid + ")");
      return kodi.Player.Open({item: { movieid: movieFound.movieid }});
    } else {
      throw new Error("Couldn\'t find movie \"" + movieTitle + "\"");
    }
  })
  .catch(function(e) {
    console.log(e);
  });
  response.sendStatus(200);
};


// Parse request to watch your next unwatched episode for a given tv show
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/playtvshow?q=[TV_SHOW_NAME]
app.get("/playtvshow", function (request, response) {
  validateRequest(request, response, kodiPlayTvshow)
});

var kodiPlayTvshow = function(request, response) {
  tryActivateTv();
  var param = {
    tvshowTitle: request.query.q.trim().toLowerCase()
  };
  
  console.log("TV Show request received to play \"" + param["tvshowTitle"] + "\"");

  kodiFindTvshow (request, response, kodiPlayNextUnwatchedEpisode, param);
};


// Parse request to watch a specific episode for a given tv show
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/playepisode?q[TV_SHOW_NAME]season[SEASON_NUMBER]episode&e[EPISODE_NUMBER]
// For example, if IP was 1.1.1.1 a request to watch season 2 episode 3 in tv show named 'bla' looks like:  
// http://1.1.1.1/playepisode?q=bla+season+2+episode&e=3
app.get("/playepisode", function (request, response) {
  validateRequest(request, response, kodiPlayEpisodeHandler)
});

var kodiPlayEpisodeHandler = function(request, response) {
  tryActivateTv();
  var requestPartOne = request.query.q.split("season");
  var param = {
    tvshowTitle: requestPartOne[0].trim().toLowerCase(),
    seasonNum: requestPartOne[1].trim().toLowerCase(),
    episodeNum: request.query.e
  };
  
  console.log("Specific Episode request received to play \"" + param["tvshowTitle"] + "\" Season " + param["seasonNum"] + " Episode " + param["episodeNum"]);
  
  kodiFindTvshow (request, response, kodiPlaySpecificEpisode, param);
};

// Parse request to watch a random episode for a given tv show
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/playrandomepisode?q[TV_SHOW_NAME]
app.get("/playrandomepisode", function (request, response) {
  validateRequest(request, response, kodiPlayRandomEpisodeHandler)
});

var kodiPlayRandomEpisodeHandler = function(request, response) {
  tryActivateTv();
  var param = {
    tvshowTitle: request.query.q.trim().toLowerCase()
  };
  
  console.log("Random Episode request received to play \"" + param["tvshowTitle"] + "\"");
  
  kodiFindTvshow (request, response, kodiPlayRandomEpisode, param);
};

app.get("/queuerandomepisode", function (request, response) {
  validateRequest(request, response, kodiQueueRandomEpisodeHandler)
});

var kodiQueueRandomEpisodeHandler = function(request, response) {
  tryActivateTv();
  var param = {
    tvshowTitle: request.query.q.trim().toLowerCase()
  };
  
  console.log("Random Episode request received to queue \"" + param["tvshowTitle"] + "\"");
  
  kodiFindTvshow(request, response, kodiQueueRandomEpisode, param);
};

app.get("/playnrandomepisodes", function (request, response) {
  validateRequest(request, response, kodiPlayNRandomEpisodesHandler)
});

var kodiPlayNRandomEpisodesHandler = function(request, response) {
  tryActivateTv();
  console.log( request.query );
  var param = {
    tvshowTitle: request.query.q.trim().toLowerCase(),
    count: parseInt( request.query.n.trim() )
  };
  
  console.log("Random N=" + param['count'] + " episodes request received to queue \"" + param["tvshowTitle"] + "\"");
  
  kodiFindTvshow(request, response, kodiPlayNRandomEpisodes, param);
};

var kodiFindTvshow = function(req, res, nextAction, param) {
  kodi.VideoLibrary.GetTVShows()
  .then(
    function(shows) {
      if(!(shows && shows.result && shows.result.tvshows && shows.result.tvshows.length > 0)) {
        throw new Error('no results');
      }
      // Create the fuzzy search object
      var fuse = new Fuse(shows.result.tvshows, fuzzySearchOptions)
      var searchResult = fuse.search(param["tvshowTitle"])

      // If there's a result
      if (searchResult.length > 0 && searchResult[0].tvshowid != null) {
        var tvshowFound = searchResult[0];
        console.log("Found tv show \"" + tvshowFound.label + "\" (" + tvshowFound.tvshowid + ")");
        param["tvshowid"] = tvshowFound.tvshowid;
        nextAction (req, res, param);
      } else {
        throw new Error("Couldn\'t find tv show \"" + param["tvshowTitle"] + "\"");
      }
    }
  )
  .catch(function(e) {
    console.log(e);
  })
};


var kodiPlayNextUnwatchedEpisode = function(req, res, RequestParams) {
  console.log("Searching for next episode of Show ID " + RequestParams["tvshowid"]  + "...");          

  // Build filter to search unwatched episodes
  var param = {
          tvshowid: RequestParams["tvshowid"],
          properties: ['playcount', 'showtitle', 'season', 'episode'],
          // Sort the result so we can grab the first unwatched episode
          sort: {
            order: 'ascending',
            method: 'episode',
            ignorearticle: true
          }
        }
  kodi.VideoLibrary.GetEpisodes(param)
  .then(function (episodeResult) {
    if(!(episodeResult && episodeResult.result && episodeResult.result.episodes && episodeResult.result.episodes.length > 0)) {
      throw new Error('no results');
    }
    var episodes = episodeResult.result.episodes;
    // Check if there are episodes for this TV show
    if (episodes) {
      console.log("found episodes..");
      // Check whether we have seen this episode already
      var firstUnplayedEpisode = episodes.filter(function (item) {
        return item.playcount === 0
      })
      if (firstUnplayedEpisode.length > 0) {
        var episdoeToPlay = firstUnplayedEpisode[0]; // Resolve the first unplayed episode
        console.log("Playing season " + episdoeToPlay.season + " episode " + episdoeToPlay.episode + " (ID: " + episdoeToPlay.episodeid + ")");
        var param = {
            item: {
              episodeid: episdoeToPlay.episodeid
            }
          }
        return kodi.Player.Open(param);
      }
    }
  })
  .catch(function(e) {
    console.log(e);
  });
  res.sendStatus(200);
};


var kodiPlaySpecificEpisode = function(req, res, RequestParams) {
  console.log("Searching Season " + RequestParams["seasonNum"] + ", episode " + RequestParams["episodeNum"] + " of Show ID " + RequestParams["tvshowid"] + "...");          

  // Build filter to search for specific season number
  var param = {
          tvshowid: RequestParams["tvshowid"],
          //episode: requestedEpisodeNum,
          season: parseInt(RequestParams["seasonNum"]),
          properties: ['playcount', 'showtitle', 'season', 'episode']
        }
  kodi.VideoLibrary.GetEpisodes(param)
  .then(function (episodeResult) {
    if(!(episodeResult && episodeResult.result && episodeResult.result.episodes && episodeResult.result.episodes.length > 0)) {
      throw new Error('no results');
    }
    var episodes = episodeResult.result.episodes;
    // Check if there are episodes for this TV show
    if (episodes) {
      console.log("found episodes..");
      // Check for the episode number requested
      var matchedEpisodes = episodes.filter(function (item) {
        return item.episode === parseInt(RequestParams["episodeNum"])
      })
      if (matchedEpisodes.length > 0) {
        var episdoeToPlay = matchedEpisodes[0];
        console.log("Playing season " + episdoeToPlay.season + " episode " + episdoeToPlay.episode + " (ID: " + episdoeToPlay.episodeid + ")");
        var param = {
            item: {
              episodeid: episdoeToPlay.episodeid
            }
          }
        return kodi.Player.Open(param);
      }
    }
  })
  .catch(function(e) {
    console.log(e);
  });
  res.sendStatus(200);
};


var kodiPlayRandomEpisode = function(req, res, RequestParams) {
  kodiSelectRandomEpisodeAnd( req, res, RequestParams, function(episodeid) {
    var param = {
      item: {
        episodeid: episodeid
      }
    };
    return kodi.Player.Open(param);
  } );
}

var kodiQueueRandomEpisode = function(req, res, RequestParams) {
  kodiSelectRandomEpisodeAnd( req, res, RequestParams, function(episodeid) {
    var param = {
      playlistid : 1,
      item: {
        episodeid: episodeid
      }
    };
    return kodi.Playlist.Add(param);
  } );
}

var kodiPlayNRandomEpisodes = function(req, res, RequestParams) {
  kodiSelectRandomEpisodeAnd( req, res, RequestParams, function(episodeid) {
    var param = {
      item: {
        episodeid: episodeid
      }
    };
    return kodi.Player.Open(param);
  } );
  for( var i = 1; i < RequestParams['count']; i++ ) {
    kodiSelectRandomEpisodeAnd( req, res, RequestParams, function(episodeid) {
      var param = {
        item: {
          episodeid: episodeid
        }
      };
      return kodi.Playlist.Add(param);
    } );
  }
}

var kodiSelectRandomEpisodeAnd = function(req, res, RequestParams, andCall) {
  console.log("Searching for random episode of Show ID " + RequestParams["tvshowid"]  + "...");          

  // Build filter to search unwatched episodes
  var param = {
          tvshowid: RequestParams["tvshowid"],
          properties: ['playcount', 'showtitle', 'season', 'episode'],
          // Sort the result so we can grab the first unwatched episode
          sort: {
            order: 'ascending',
            method: 'episode',
            ignorearticle: true
          }
        }
  kodi.VideoLibrary.GetEpisodes(param).then(function (episodeResult) {
    if(!(episodeResult && episodeResult.result && episodeResult.result.episodes && episodeResult.result.episodes.length > 0)) {
      throw new Error('no results');
    }
    var episodes = episodeResult.result.episodes;
    // Check if there are episodes for this TV show
    if (episodes) {
      console.log("found " + episodes.length + " episodes of " + episodes[0].showtitle);
      // Calculate the number of episodes + total play counts
      // we'll use an "inverse of play count" as a way to bias the
      // random selection, so it is possible to randomly select the
      // most watched episode, but more probable to select the lesser
      // watched episode(s)
      var maxPlayed = episodes.map(function(item) { return item.playcount; }).reduce(function(l, r) { return Math.max(l, r); });
      console.log('maxPlayed = ' + maxPlayed);
      var bigCount = episodes.map(function (item) { return maxPlayed - item.playcount + 1; })
          .reduce(function(left, right) { return left + right; });
      var picked = Math.floor( Math.random() * bigCount );
      console.log('Random selection: ' + picked +  ' (out of ' + bigCount + ', maxPlayed=' + maxPlayed + ')');
      for( var i = 0, count = 0; i < episodes.length; i++ ) {
        count += maxPlayed - episodes[i].playcount + 1;
        if( picked < count ) {
          var e = episodes[i];
          console.log("Playing season " + e.season + " episode " + e.episode
                      + " (ID: " + e.episodeid + "), played " + e.playcount + " times before");
          return andCall( episodes[i].episodeid );
        }
      }
      console.log("ERROR! Picked " + picked + " out of " + bigCount + " but didn't select any of " + episodes.length + " episodes?");
    }
  })
  .catch(function(e) {
    console.log(e);
  });
  res.sendStatus(200);
};


// Parse request to watch a PVR channel by name
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/playpvrchannelbyname?q=[CHANNEL_NAME]
app.get("/playpvrchannelbyname", function (request, response) {
  validateRequest(request, response, kodiPlayChannelByName)
});

// Parse request to watch a PVR channel by number
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/playpvrchannelbynumber?q=[CHANNEL_NUMBER]
app.get("/playpvrchannelbynumber", function (request, response) {
  validateRequest(request, response, kodiPlayChannelByNumber)
});

var kodiPlayChannelByName = function(request, response) {
  tryActivateTv();
  kodiPlayChannel(request, response, fuzzySearchOptions);
}
  
var kodiPlayChannelByNumber = function(request, response) {
  tryActivateTv();
  var pvrFuzzySearchOptions = JSON.parse(JSON.stringify(fuzzySearchOptions));
  pvrFuzzySearchOptions.keys[0] = "channelnumber"
  kodiPlayChannel(request, response, pvrFuzzySearchOptions);
}
  
var kodiPlayChannel = function(request, response, searchOptions) {
  
  var reqChannel = request.query.q.trim();
  console.log("PVR channel request received to play \"" + reqChannel + "\"");
    
  // Build filter to search TV channel groups
  var param = {
    channeltype : "tv"
  }
  
  kodi.PVR.GetChannelGroups(param)
  .then(function(channelGroups) {
    if(!(channelGroups && channelGroups.result && channelGroups.result.channelgroups && channelGroups.result.channelgroups.length > 0)) {
      throw new Error('no channels group were found. Perhaps PVR is not setup?');
    }

    // For each tv PVR channel group, search for all channels
    var chGroups = channelGroups.result.channelgroups;
    
    tryPlayingChannelInGroup(searchOptions, reqChannel, chGroups, 0);
  })
  .catch(function(e) { 
        console.log(e);
  })
};

    
var tryPlayingChannelInGroup = function(searchOptions, reqChannel, chGroups, currGroupI) {
    if (currGroupI < chGroups.length) {
      
      // Build filter to search for all channel under the channel group
      var param = {
        channelgroupid : chGroups[currGroupI].channelgroupid
      }
      
      kodi.PVR.GetChannels(param)
      .then(function(channels) {
        if(!(channels && channels.result && channels.result.channels && channels.result.channels.length > 0)){ 
          throw new Error('no channels were found');
        }
        
        var rChannels = channels.result.channels;
        // Create the fuzzy search object
        var fuse = new Fuse(rChannels, searchOptions)
        var searchResult = fuse.search(reqChannel)
        
        // If there's a result
        if (searchResult.length > 0) {
          var channelFound = searchResult[0];
          console.log("Found PVR channel \"" + channelFound.label + "\" - " + channelFound.channelnumber + " (" + channelFound.channelid + ")");
          return kodi.Player.Open({item: { channelid: channelFound.channelid }}); 
        } else {
          
          tryPlayingChannelInGroup(searchOptions, reqChannel, chGroups, currGroupI+1);
        }
      })
      .catch(function(e) { 
        console.log(e);
      })
    }
  };

// Parse request to execute addon
// Request format:   http://[THIS_SERVER_IP_ADDRESS]/executeaddon?q=[ADDON_NAME]
app.get("/executeaddon", function (request, response) {
  validateRequest(request, response, kodiExecuteAddon)
});

var kodiExecuteAddon = function(request, response) {
  var param = {
    addonName: request.query.q.trim().toLowerCase()
  };
  
  console.log('Addon request received to execute "' + param["addonName"] + '"');

  kodiFindAddon(request, response, param);
};

var kodiFindAddon = function( req, res, param ) {
  kodi.Addons.GetAddons()
  .then(
    function(addons) {
      if(!(addons && addons.result && addons.result.addons && addons.result.addons.length > 0)) {
        throw new Error('no results');
      }
      // fuzzy search
      var searchResult = [];
      for( var i = 0; i < addons.result.addons.length; i++ ) {
        if( addons.result.addons[i]['addonid'].indexOf( param['addonName'] ) != -1 ) {
          searchResult = [ addons.result.addons[i] ];
          break;
        }
      }
//      var fuse = new Fuse(addons.result.addons, fuzzySearchOptions)
//      var searchResult = fuse.search(param["addonName"])

      // If there's a result
      if (searchResult.length > 0 && searchResult[0].addonid != null) {
        var addonFound = searchResult[0];
        console.log('Found addon "' + addonFound.addonid + '" (type ' + addonFound.type + ")");
        param["addonid"] = addonFound.addonid;
        kodi.Addons.ExecuteAddon( { "addonid" : addonFound.addonid } );
      } else {
        throw new Error("Couldn\'t find addon \"" + param["addonName"] + "\" in the " + addons.result.addons.length + " addons listed: " + searchResult );
      }
    } )
  .catch( function( e ) {
    console.log( e );
  } )

  res.sendStatus(200);
};


app.get("/", function (request, response) {
  response.sendFile(__dirname + '/views/index.html');
});

// listen for requests :)
var listener = app.listen(process.env.PORT, function () {
  console.log('Your app is listening on port ' + listener.address().port);
});