/**
 * Tropo Browser <-> Phone chat client. 
 * @author Michael Mackus
 * 
 * Original blog post: http://disruptive.io/2011/04/27/tropo-chat-client/
 */

var http = require('http'),
	io = require('socket.io'),
	express = require('express'),
	sys = require('sys'),
	url = require('url');
require('tropo-webapi');

// Create the Express.JS web server
server = express.createServer();
server.configure(function() {
	server.use(express.bodyParser()); // Parse JSON request bodies
});
server.listen(8000); // Change this port number to the port you want the app to listen on

/** 
 * Socket.IO - Web Client. Socket.IO is a simple, cross-browser library for Node.js 
 * allowing one to easily make realtime apps. http://socket.io/
 **/
var socket = io.listen(server);
var userlist = {}; // List of users connected to chat, indexed by there node session ids
// Function to refresh the clients' userlist
function refreshUsers() {
	var users = {userlist: []};
	for (userId in userlist) {
		users.userlist.push(userlist[userId]);
	}
	socket.broadcast(users);
}
// Handle client connections to our Socket.IO instance
socket.on('connection', function(client) {
	console.log('Client connection.');

	// Notify the other clients
	//client.broadcast("Web client connected.");

	// Handle messages ("chats") from the client
	client.on('message', function(msg) {
		console.log(msg); // Log the message
		if ('connected' in msg) {
			client.broadcast({announcement: msg.nickname + ' connected.'});
			userlist[client.sessionId] = msg.nickname;
			refreshUsers();
		} else {
			client.broadcast(msg); // Broadcast the message to other clients
			broadcastToCalls(msg); // Broadcast the message to calls
		}
	});
	client.on('disconnect', function() {
		delete userlist[client.sessionId];
		refreshUsers();
	});

});

/** 
 * Tropo - Phone Client 
 **/
// Tropo clients object - holds the chat messages queue for a particular client
var tropoClients = {};
// Holds data for the tropo clients - such as the phone number
var tropoClientData = {};
// Broadcasts a chat message to all phones connected to the IVR by issuing an 
// interrupt event with Tropo's rest api.
function broadcastToCalls(msg) {
	// Loop through connected tropo clients
	for (sessionId in tropoClients) {
		// Send message to client
		if (typeof msg == 'string')
			tropoClients[sessionId].push(msg); // Add message to the client's queue
		else
			tropoClients[sessionId].push(msg.nickname + ' says ' + msg.chat); // Add message to the client's queue

		// Send interrupt signal
		console.log(sessionId);
		var signalURL = 'https://api.tropo.com/1.0/sessions/'+sessionId+'/signals?action=signal&value=chat';
		var siteURL = url.parse(signalURL);
		var site = http.createClient(80, siteURL.host);
		var request = site.request("GET", siteURL.pathname, {'host' : siteURL.host})
		request.end();
	}
}
// Phone call say messages.
var phoneWelcome ="Welcome to the tropo chat demo. Press asterisk to start recording your message, and press pound when you are done. Speak slowly to improve the quality of the transcription.";
var phoneWait ="http://www.phono.com/audio/holdmusic.mp3";
var phoneTranscribe = "Say what you would like to chat.";
var phonoNum=0; // Number of phono clients - phono has long, weird IDs so we refer to phono clients as "phono-x"
/**
 * Phone call web requests (IVR)
 */
// Start of IVR (welcome message)
server.all('/tropo.json', function(req, res) {
	// Log the phone number for future access
	var callerId = req.body.session.from.id;
	if (callerId.search('-') > -1) {
		phonoNum++;
		callerId = 'phono-'+phonoNum;
	}
	tropoClientData[req.body.session.id] = {caller_id: callerId};

	// Instance of the tropo WebAPI object - see www.tropo.com for docs
	var tropo = new TropoWebAPI();

	tropo.say(phoneWelcome);

	// Tropo events
	tropo.on('continue', null, '/wait');
	tropo.on('incomplete', null, '/wait');
	tropo.on('error', null, '/wait');
	tropo.on('hangup', null, '/endcall');

	res.send(TropoJSON(tropo));
});
// IVR wait loop - plays hold music, waiting for an event from either 1) the rest API (a chat was recieved), or 2) the user 
server.all('/wait', function(req, res) {
	var sessionId = req.body.result.sessionId;

	if (typeof tropoClients[sessionId] == 'undefined') {
		tropoClients[sessionId] = []; // Initialize this client's message queue
		// Update the userlists with the phone number
		userlist[sessionId] = tropoClientData[sessionId].caller_id;
		refreshUsers();
		socket.broadcast({announcement: 'Phone number ' + tropoClientData[sessionId].caller_id + ' connected.'});
	}

	var tropo = new TropoWebAPI();

	var phoneWaitSay = new Say(phoneWait);
	var phoneWaitChoices = new Choices('*');
	tropo.ask(phoneWaitChoices, 100, true, null, 'wait', null, true, phoneWaitSay, 1, null);

	// Tropo events
	tropo.on('continue', null, '/record');
	tropo.on('incomplete', null, '/record');
	tropo.on('error', null, '/wait');
	tropo.on('hangup', null, '/endcall');

	res.send(TropoJSON(tropo));
});
// IVR record function. First checks if there are messages in the queue, and if so processes the messages and returns to loop.
// If no messages are in queue, the IVR assumes this was a user initiated event and starts the recording.
server.all('/record', function(req, res) {
	var sessionId = req.body.result.sessionId;

	var tropo = new TropoWebAPI();

	// Check for new messages
	var msgRecieved = false;
	while (msg = tropoClients[req.body.result.sessionId].pop()) {
		msgRecieved = true;

		tropo.say(msg);
	}

	// Don't record if a message was recieved
	// This would be better done with Tropo custom events, but I couldn't figure them out with tropo web api.
	if (!msgRecieved) {
		var say = new Say(phoneTranscribe);
		var choices = new Choices(null, null, "#");
		
		// For the recording
		var caller_id = tropoClientData[sessionId].caller_id;

		// Record the user
		tropo.record(1, false, null, choices, null, 5, 60, null, null, "recording", null, say, 5, {url:'http://web1.disruptive.io:8000/transcribe?caller_id=' + caller_id}, null, null, null);
	}

	// Tropo events
	tropo.on('continue', null, '/wait');
	tropo.on('incomplete', null, '/wait');
	tropo.on('error', null, '/wait');
	tropo.on('hangup', null, '/endcall');

	res.send(TropoJSON(tropo));
});
// Transcribe function. Callback for the /record record function. Sends the transcribed text to the connected clients.
server.all('/transcribe', function(req, res) {
	// For some reason, the message is encoded as JSON in the first key of req.body
	for (msg in req.body) {
		var msgObj = JSON.parse(msg);
		console.log(msgObj); // Log the message
		socket.broadcast({nickname: req.query.caller_id, chat: msgObj.result.transcription});
		break;
	}
});
// End the call, remove this from the userlist
server.all('/endcall', function(req, res) {
	var sessionId = req.body.result.sessionId;
	
	// Check if this is a phono client 
	if (tropoClientData[sessionId].caller_id.search('phono-') > -1) {
		phonoNum--;
	}
	
	delete tropoClients[sessionId];
	delete tropoClientData[sessionId];
	delete userlist[sessionId];
	
	refreshUsers();
});
// HTTP request for the root of the node.js site, so Monit can properly check the status
server.all('/', function(req, res) {
	res.send('<h1>Hello from Express.JS</h1>');
});
