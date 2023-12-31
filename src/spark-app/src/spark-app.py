"""PySpark entrypoint."""
import logging
import pyspark.sql.functions as F
from pyspark.sql.types import IntegerType, StringType, StructType, TimestampType
from model import load_model, train_model, regex_replace
from database import save_tweets_to_db, save_events_to_db
from session import spark

# Use PySpark logging format
logging.basicConfig(format='%(asctime)s %(levelname)s %(message)s', datefmt='%y/%m/%d %H:%M:%S')
logging.getLogger().setLevel(logging.INFO)

_WINDOW_DURATION = '1 minute'
_SLIDING_DURATION = '1 minute'

# Read messages from Kafka topics: tracking-tweets, tracking-events
kafka_messages = spark.readStream.format('kafka').option(
    'kafka.bootstrap.servers',
    'my-cluster-kafka-bootstrap:9092',
).option(
    'subscribePattern',
    'tracking-*',
).option(
    'startingOffsets',
    'earliest',
).load()

# Define schema of tracking-tweets
tweets_message_schema = StructType().add(
    'tweet_id',
    IntegerType(),
).add(
    'tweet',
    StringType(),
).add(
    'timestamp',
    IntegerType(),
)

# Define schema of tracking-events
events_message_schema = StructType().add(
    'event_type',
    StringType(),
).add(
    'timestamp',
    IntegerType(),
)

# Convert value of tweets: binary -> JSON -> fields + parsed timestamp
tweets_messages = kafka_messages.where("topic = 'tracking-tweets'").select(
    # Extract 'value' from Kafka message
    F.from_json(
        F.column('value').cast('string'),
        tweets_message_schema,
    ).alias('json')).select(
        # Convert Unix timestamp to TimestampType
        F.from_unixtime(F.column('json.timestamp')).cast(TimestampType()).alias('parsed_timestamp'),
        F.column('json.tweet_id').alias('tweet_id'),
        F.column('json.tweet').alias('tweet'),
    ).withWatermark(
        'parsed_timestamp',
        _WINDOW_DURATION,
    )

# Convert value of events: binary -> JSON -> fields + parsed timestamp
events_messages = kafka_messages.where("topic = 'tracking-events'").select(
    # Extract 'value' from Kafka message
    F.from_json(
        F.column('value').cast('string'),
        events_message_schema,
    ).alias('json')).select(
        # Convert Unix timestamp to TimestampType
        F.from_unixtime(F.column('json.timestamp')).cast(TimestampType()).alias('parsed_timestamp'),
        F.column('json.event_type').alias('event_type'),
    ).withWatermark(
        'parsed_timestamp',
        _WINDOW_DURATION,
    )

# Compute popular tweets
popular_tweets = tweets_messages.groupBy(
    F.window(F.column('parsed_timestamp'), _WINDOW_DURATION, _SLIDING_DURATION),
    F.column('tweet'),
    F.column('tweet_id'),
).count()

# Compute system events
system_events = events_messages.groupBy(
    F.window(F.column('parsed_timestamp'), _WINDOW_DURATION, _SLIDING_DURATION),
    F.column('event_type'),
).count()

# Rename window
popular_tweets.window.start.alias('window_end')
popular_tweets.window.end.alias('window_start')
system_events.window.start.alias('window_end')
system_events.window.end.alias('window_start')

# Load or train tweet sentiment prediction model
try:
    model_pipeline = load_model()
except:
    logging.info('No PySpark PipelineModel found. Training model instead.')
    model_pipeline = train_model()

# Predict sentiment of tweets
popular_tweets = regex_replace(popular_tweets)
popular_tweets = model_pipeline.transform(popular_tweets)

# Print running counts to the console
tweets_console_dump = popular_tweets.writeStream.outputMode('update').format('console').start()
events_console_dump = system_events.writeStream.outputMode('update').format('console').start()

# Save each tweet batch to MariaDB
tweets_db_insert_stream = popular_tweets.select(
    F.column('tweet_id'),
    F.column('count'),
    F.column('prediction'),
).writeStream.outputMode('complete').foreachBatch(save_tweets_to_db).start()

# Save each event batch to MariaDB
events_db_insert_stream = system_events.select(
    F.column('event_type'),
    F.column('count'),
).writeStream.outputMode('complete').foreachBatch(save_events_to_db).start()

# Wait for termination
spark.streams.awaitAnyTermination()
