const moment = require("moment");
const os = require("os");
const dns = require("dns").promises;
const { program: optionparser } = require("commander");
const { Kafka } = require("kafkajs");
const mariadb = require("mariadb");
const MemcachePlus = require("memcache-plus");
const express = require("express");

const app = express();

const CACHE_TIME_SECONDS = 15;
const NUMBER_OF_TWEETS = 30;

function logging(message) {
  const dateTime = new Date();
  console.log(
    moment(dateTime).format("YY/MM/DD HH:MM:SS") + " INFO " + message
  );
}

// -------------------------------------------------------
// Command-line options (with sensible defaults)
// -------------------------------------------------------

let options = optionparser
  .storeOptionsAsProperties(true)
  // Web server
  .option("--port <port>", "Web server port", 3000)
  // Kafka options
  .option(
    "--kafka-broker <host:port>",
    "Kafka bootstrap host:port",
    "my-cluster-kafka-bootstrap:9092"
  )
  .option(
    "--kafka-topic-tweets <topic>",
    "Kafka topic to tweets send to",
    "tweets"
  )
  .option(
    "--kafka-topic-events <topic>",
    "Kafka topic to events send to",
    "events"
  )
  .option(
    "--kafka-client-id < id > ",
    "Kafka client ID",
    "my-app"
    // "tracker-" + Math.floor(Math.random() * 100000)
  )
  // Memcached options
  .option(
    "--memcached-hostname <hostname>",
    "Memcached hostname (may resolve to multiple IPs)",
    "my-memcached-service"
  )
  .option("--memcached-port <port>", "Memcached port", 11211)
  .option(
    "--memcached-update-interval <ms>",
    "Interval to query DNS for memcached IPs",
    5000
  )
  // Database options
  .option("--mariadb-host <host>", "MariaDB host", "my-app-mariadb-service")
  .option("--mariadb-port <port>", "MariaDB port", 3306)
  .option("--mariadb-schema <db>", "MariaDB Schema/database", "popular")
  .option("--mariadb-username <username>", "MariaDB username", "root")
  .option("--mariadb-password <password>", "MariaDB password", "mysecretpw")
  // Misc
  .addHelpCommand()
  .parse()
  .opts();

// -------------------------------------------------------
// Database Configuration
// -------------------------------------------------------

const pool = mariadb.createPool({
  host: options.mariadbHost,
  port: options.mariadbPort,
  database: options.mariadbSchema,
  user: options.mariadbUsername,
  password: options.mariadbPassword,
  connectionLimit: 5,
});

async function executeQuery(query, data) {
  let connection;
  try {
    connection = await pool.getConnection();
    logging("Executing query " + query);
    let res = await connection.query({ rowsAsArray: true, sql: query }, data);
    return res;
  } finally {
    if (connection) connection.end();
  }
}

// -------------------------------------------------------
// Memcache Configuration
// -------------------------------------------------------

//Connect to the memcached instances
let memcached = null;
let memcachedServers = [];

async function getMemcachedServersFromDns() {
  try {
    // Query all IP addresses for this hostname
    let queryResult = await dns.lookup(options.memcachedHostname, {
      all: true,
    });

    // Create IP:Port mappings
    let servers = queryResult.map(
      (el) => el.address + ":" + options.memcachedPort
    );

    // Check if the list of servers has changed
    // and only create a new object if the server list has changed
    if (memcachedServers.sort().toString() !== servers.sort().toString()) {
      logging("Updated memcached server list to " + servers);
      memcachedServers = servers;

      //Disconnect an existing client
      if (memcached) await memcached.disconnect();

      memcached = new MemcachePlus(memcachedServers);
    }
  } catch (e) {
    logging("Unable to get memcache servers (yet)");
  }
}

//Initially try to connect to the memcached servers, then each 5s update the list
getMemcachedServersFromDns();
setInterval(
  () => getMemcachedServersFromDns(),
  options.memcachedUpdateInterval
);

//Get data from cache if a cache exists yet
async function getFromCache(key) {
  if (!memcached) {
    logging(
      `No memcached instance available, memcachedServers = ${memcachedServers}`
    );
    return null;
  }
  return await memcached.get(key);
}

// -------------------------------------------------------
// Kafka Configuration
// -------------------------------------------------------

// Kafka connection
const kafka = new Kafka({
  clientId: options.kafkaClientId,
  brokers: [options.kafkaBroker],
  retry: {
    retries: 0,
  },
});

const producer = kafka.producer();
// End

// Send tracking message to Kafka
async function sendTweetMessage(data) {
  //Ensure the producer is connected
  await producer.connect();

  //Send message
  let result = await producer.send({
    topic: options.kafkaTopicTweets,
    messages: [{ value: JSON.stringify(data) }],
  });

  logging("Send result = " + JSON.stringify(result));
  return result;
}

async function sendEventMessage(data) {
  await producer.connect();

  let result = await producer.send({
    topic: options.kafkaTopicEvents,
    messages: [{ value: JSON.stringify(data) }],
  });

  logging("Send result = " + JSON.stringify(result));
  return result;
}
// End

// -------------------------------------------------------
// HTML helper to send a response to the client
// -------------------------------------------------------

function sendResponse(res, html, cachedResult) {
  res.send(`<!DOCTYPE html>
  <html lang="en">
  <head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Big Data Use-Case Demo</title>
			<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/mini.css/3.0.1/mini-default.min.css">
			<script>
        function fetchRandomTweets() {
          const maxRepetitions = Math.floor(Math.random() * 200)
          document.getElementById("out").innerText = "Fetching " + maxRepetitions + " random tweets, see console output"
            for(var i = 0; i < maxRepetitions; ++i) {
              const tweetId = Math.floor(Math.random() * ${NUMBER_OF_TWEETS})
              fetch("/tweets/" + tweetId + "/fetched", {cache: 'no-cache'})
          }
        }
			</script>
		</head>
		<body>
			<h1>Twitter Sentiment Analysis</h1>
			<p>
				<a href="javascript: fetchRandomTweets();">Randomly fetch some tweets</a>
				<span id="out"></span>
			</p>
			${html}
			<hr>
			<h2>Information about the generated page</h4>
			<ul>
				<li>Server: ${os.hostname()}</li>
				<li>Date: ${new Date()}</li>
				<li>Using ${memcachedServers.length} memcached Servers: ${memcachedServers}</li>
				<li>Cached result: ${cachedResult}</li>
			</ul>
		</body>
	</html>
	`);
}

// -------------------------------------------------------
// Start page
// -------------------------------------------------------

// Get list of tweets (from cache or db)
async function getTweets() {
  const key = "tweets";
  let cacheData = await getFromCache(key);

  if (cacheData) {
    logging(
      `Cache hit for key = ${key}, cacheData = ${JSON.stringify(cacheData)}`
    );
    return { result: cacheData, cached: true };
  } else {
    logging(`Cache miss for key = ${key}, querying database`);
    const data = await executeQuery(
      "SELECT tweet_id FROM tweets ORDER BY tweet_id",
      []
    );
    if (data) {
      let result = data.map((row) => row?.[0]);
      logging("Got result = " + JSON.stringify(result) + " storing in cache");
      if (memcached) await memcached.set(key, result, CACHE_TIME_SECONDS);
      return { result, cached: false };
    } else {
      throw "No tweets data found";
    }
  }
}

// Get popular tweets (from db only)
async function getPopular(maxCount) {
  const query =
    "SELECT popular.tweet_id, popular.sentiment, popular.count, tweets.author FROM popular JOIN tweets ON tweets.tweet_id = popular.tweet_id ORDER BY count DESC LIMIT ?";
  return (await executeQuery(query, [maxCount])).map((row) => ({
    tweetId: row?.[0],
    sentiment: row?.[1],
    count: row?.[2],
    author: row?.[3],
  }));
}

async function getEvents() {
  return (
    await executeQuery(
      "SELECT event_type, count FROM events ORDER BY count DESC",
      []
    )
  ).map((row) => ({
    eventType: row?.[0],
    count: row?.[1],
  }));
}

// Return HTML for start page
app.get("/", (req, res) => {
  const topX = 10;
  Promise.all([getTweets(), getPopular(topX), getEvents()]).then((values) => {
    const tweets = values[0];
    const popular = values[1];
    const events = values[2];

    const tweetsHtml = tweets.result
      .map((tweetId) => `<a href='tweets/${tweetId}/clicked'>${tweetId}</a>`)
      .join(", ");

    const popularHtml = popular
      .map(
        (pop) =>
          `<li> 
            Author:
            <a href='tweets/${pop.tweetId}/clicked'>${pop.author}</a> (${
            pop.count
          } views) - sentiment: ${pop.sentiment === 1 ? "positive" : "negative"}
          </li>`
      )
      .join("\n");

    const eventsHtml = events
      .map(
        (event) =>
          `<li> 
          Event: ${event.eventType} tweets (count: ${event.count})
        </li>`
      )
      .join("\n");

    const html = `
      <h1>All Tweets</h1>
      <p> ${tweetsHtml} </p>
			<h1>Top ${topX} Tweets</h1>		
			<p>
				<ol style="margin-left: 2em;"> ${popularHtml} </ol> 
			</p>
      <h1>System Events</h1>		
			<p>
				<ol style="margin-left: 2em;"> ${eventsHtml} </ol> 
			</p>
		`;
    sendResponse(res, html, tweets.cached);
  });
});

// -------------------------------------------------------
// Get a specific tweet (from cache or DB)
// -------------------------------------------------------

async function getTweet(tweetId) {
  const query = "SELECT tweet_id, tweet, author FROM tweets WHERE tweet_id = ?";
  const key = tweetId;
  let cacheData = await getFromCache(key);

  if (cacheData) {
    logging(
      `Cache hit for key = ${key}, cacheData = ${JSON.stringify(cacheData)}`
    );
    return { ...cacheData, cached: true };
  } else {
    logging(`Cache miss for key = ${key}, querying database`);

    let data = (await executeQuery(query, [tweetId]))?.[0]; // first entry
    if (data) {
      let result = {
        tweetId: data?.[0],
        tweet: data?.[1],
        author: data?.[2],
      };
      logging(`Got result = ${JSON.stringify(result)}, storing in cache`);
      if (memcached) await memcached.set(key, result, CACHE_TIME_SECONDS);
      return { ...result, cached: false };
    } else {
      throw "No data found for this tweet";
    }
  }
}

app.get("/tweets/:id/:event", async (req, res) => {
  let event = req.params["event"];
  let tweetId = req.params["id"];
  logging("Fetching tweet id " + tweetId);
  logging("Event type " + event);
  const tweet = await getTweet(tweetId);

  // Send the tracking message to Kafka
  sendTweetMessage({
    tweet_id: tweet.tweetId,
    tweet: tweet.tweet,
    timestamp: Math.floor(new Date() / 1000),
  })
    .then(() =>
      logging(
        `Sent tweet = ${tweetId} to kafka topic = ${options.kafkaTopicTweets}`
      )
    )
    .catch((err) => logging("Error sending to kafka " + err));

  sendEventMessage({
    event_type: event,
    timestamp: Math.floor(new Date() / 1000),
  })
    .then(() =>
      logging(
        `Sent event = ${event} tweet to kafka topic = ${options.kafkaTopicEvents}`
      )
    )
    .catch((err) => logging("Error sending to kafka " + err));

  // Send reply to browser
  getTweet(tweetId)
    .then((data) => {
      sendResponse(
        res,
        `<h1>${data.tweetId}</h1><p>${data.author}</p>` +
          data.tweet
            .split("\n")
            .map((p) => `<p>${p}</p>`)
            .join("\n"),
        data.cached
      );
    })
    .catch((err) => {
      sendResponse(res, `<h1>Error</h1><p>${err}</p>`, false);
    });
});

// Simulate data streaming
setInterval(async () => {
  const tweetId = Math.floor(Math.random() * NUMBER_OF_TWEETS);
  const tweet = await getTweet(tweetId.toString());
  sendTweetMessage({
    tweet_id: tweet.tweetId,
    tweet: tweet.tweet,
    timestamp: Math.floor(new Date() / 1000),
  })
    .then(() =>
      logging(
        `Sent tweet = ${tweetId} to kafka topic = ${options.kafkaTopicTweets}`
      )
    )
    .catch((err) => logging("Error sending to kafka " + err));

  sendEventMessage({
    event_type: "streamed",
    timestamp: Math.floor(new Date() / 1000),
  })
    .then(() =>
      logging(
        `Sent event = streamed tweet to kafka topic = ${options.kafkaTopicEvents}`
      )
    )
    .catch((err) => logging("Error sending to kafka " + err));
}, 5000);

// -------------------------------------------------------
// Main method
// -------------------------------------------------------

app.listen(options.port, function () {
  logging(
    "Node app is running at http://localhost:" +
      options.port +
      " in popular-slides-web"
  );
});
