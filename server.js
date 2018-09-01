const path = require("path");
const MongoClient = require('mongodb').MongoClient;
const Eos = require("eosjs");
const express = require("express");
const app = express();
const http = require('http').Server(app);
const io = require("socket.io")(http);

var eos = Eos({
	httpEndpoint: 'http://127.0.0.1:8888',
	chainId: "cf057bbfb72640471fd910bcb67639c22df9f92470936cddc1ade0e2f2e7dc4f",
	verbose: true
});

///Middleware
app.use("/assets", express.static(path.join(__dirname, "src", "assets")));
app.use("/public", express.static(path.join(__dirname, "src", "public")));

app.get("/", (req, res) => {
	res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

const url = 'mongodb://localhost:27017';

// Database Name
const dbName = 'EOS';
let db = null;

// Use connect method to connect to the server
MongoClient.connect(url, { useNewUrlParser: true }, (err, client) => {
	console.log("Connected successfully to server");
	db = client.db(dbName);
});

let sessions = []; //Array of contracts that are currently being polled

app.get("/getorders/:contract", (req, res) => {
	//startOrderPoll( "gem", { typeofreq: "getrequest", res: res, req: req } );
});


io.on( 'connection', function(socket) {
	let changeStreamCursor;
	let initiatedPoll = false;
	let contractInitiated;
	
	socket.on("disconnect", () => {
		console.log("User disconnected");
		///Remove the session if the user initiated one after he disconnects
		if ( initiatedPoll ) {
			sessions.forEach(( session ) => {
				if ( session === contractInitiated ) {
					let i = sessions.indexOf(session);
    				if (i >= 0) {
    					sessions.splice(i, 1);
    				}
				}
			});
			console.log("Here are the sessions: " + sessions)
		}
	});

	socket.on("order-request", ( contract ) => {
		let isLive = false;
		sessions.forEach(( session ) => {
			if ( session === contract ) {
				isLive = true;
			}
		});
		if ( !isLive ) {
			sessions.push( contract );
			startOrderPoll( contract );
			initiatedPoll = true;
			contractInitiated = contract;
		}
		changeStreamCursor = db.collection(`${contract}cachedorders`).watch({});
		changeStreamCursor.on("change", function() {
			db.collection(`${contract}cachedorders`).find({}).toArray((err, doc)=> {
				socket.emit("orders-sent", doc);
			});
		});
		db.collection(`${contract}cachedorders`).find({}).toArray((err, doc)=> {
			socket.emit("orders-sent", doc);
		});
	});
});

http.listen(3000, function(){
	console.log('listening on *:3000');
});


function startOrderPoll( contract ) {
	if ( sessions.length === 0 ) {
		return;
	}
	for (var i = 0; i < sessions.length; i++) {
		if ( sessions[i] === contract ) {
			break;
		}
		if ( i === sessions.length - 1 ) {
			return;
		}
	}
	eos.getTableRows({	code: "exchange5",
						scope: contract,
						table: "orders",
						limit: 0,
						json: true }).then( orders => {
							///Sort the orders and push them into the cache
							let buyOrders = [];
							let sellOrders = [];
							orders.rows.forEach(( order ) => {
								if (order.buy_or_sell == 0) {
									sellOrders.push( order );
								} else {
									buyOrders.push( order );
								}
							});
							buyOrders.sort((a, b) => { return b.price - a.price}).splice(100);
							sellOrders.sort((a, b) => { return a.price - b.price}).splice(100);
							db.collection(`${contract}cachedorders`).count().then( count => {
								if ( count === 0 ) {
									db.createCollection(`${contract}cachedorders`);
									db.collection(`${contract}cachedorders`).insertOne( { name: "Orders", buyOrders: buyOrders, sellOrders: sellOrders } );
								} else if ( count > 0 ) {
									db.collection(`${contract}cachedorders`).updateMany( { name: "Orders" }, { $set: { buyOrders: buyOrders, sellOrders: sellOrders } } );
								}
							});
							/*if ( type.typeofreq === "getrequest" ) {
								db.collection(`${type.req.params.contract}cachedorders`).find({}).toArray((err, doc)=> {
									type.res.send(doc);
								});
								return;
							}*/
							setTimeout(() => { 
									startOrderPoll( contract );
								}, 1000); //Query table every 1000ms
						});
}
 
///TODO: Listen for takeorders


/** TODO: Implement a way to cache the orders as they come in from nodeos mongodb plugin
/// Insert order into all orders of token token_contract+totalorders colletion
/// Check if cached orders for the token is less than 100 and insert OR
/// Check if order is better than the cached orders for the token and insert into cache (delete worse order)
const listenForMakeOrder = function(db, callback) {
	const collection = db.collection("action_traces");
	const changeStreamCursor = collection.watch([{$match: {"fullDocument.act.name": "makeorder"}}]);
	//Handler for listenting to the change
	changeStreamCursor.on("change", function(change) {
		const token_contract = change.fullDocument.act.data.target_token_contract; 
		db.listCollections({name: token_contract}).next(function(err, collref) {
			if (!collref) {
				db.createCollection("totalorders" + token_contract);
				db.createCollection("cachedorders" + token_contract);
			}
		});
		const totalOrders = db.collection("totalorders" + token_contract);
		totalOrders.insertOne(change.fullDocument.act.data);

		const cachedOrders = db.collection("cachedorders" + token_contract);
		const buy_or_sell = change.fullDocument.act.data.buy_or_sell;
		cachedOrders.countDocuments({ "buy_or_sell" : buy_or_sell }).then(count => {
			if (count <= 100) {
				cachedOrders.insertOne(change.fullDocument.act.data);	
			} else {
				const price = change.fullDocument.act.data.price;
				if ( buy_or_sell == 0 ) { //sell order: Check if price is cheaper than the maximum price then insert order into the cache
					cachedOrders.find({buy_or_sell : 0}).sort({amount_of_token:+1}).limit(1).toArray((err, maxSellOrder)=>{
						if ( price < maxSellOrder[0].price ) {
							cachedOrders.deleteOne({_id: maxSellOrder[0]._id});
							cachedOrders.insertOne(change.fullDocument.act.data);
						}
					});	
				} else if ( buy_or_sell == 1) { //buy order: Check if price is greater than the minimum price then insert order into the cache
					cachedOrders.find({buy_or_sell : 1}).sort({amount_of_token:-1}).limit(1).toArray((err, minBuyOrder)=>{
						if ( price > minBuyOrder[0].price ) {
							cachedOrders.deleteOne({_id: minBuyOrder[0]._id});
							cachedOrders.insertOne(change.fullDocument.act.data);
						}
					});
				}
			}
		});
	});
}

/// Remove the order from total orders
/// Remove the order from cached orders
const listenForCancelOrder = function(db, callback) {
	const collection = db.collection("action_traces");	
	const changeStreamCursor = collection.watch([{$match: {"fullDocument.act.name": "cancelorder"}}]);
	changeStreamCursor.on("change", function(change) {
		const token_contract = change.fullDocument.act.data.target_token_contract; 
		const totalOrders = db.collection("totalorders" + token_contract);
		const cachedOrders = db.collection("cachedorders" + token_contract);

		totalOrders.find({})

	});

}
*/