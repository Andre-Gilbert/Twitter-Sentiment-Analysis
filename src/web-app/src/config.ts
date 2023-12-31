/** The application configuration. */
import { program } from "commander";

export const options = program
    .storeOptionsAsProperties(true)
    // Web server
    .option("--port <port>", "Web server port", "3000")
    .option("--cache-time <s>", "Memcached cache time in seconds", "15")
    .option("--top-x-tweets <count>", "Number of popular tweets to query", "10")
    .option("--number-of-tweets <count>", "Number of tweets in MariaDB", "30")
    // Kafka options
    .option("--kafka-broker <host:port>", "Kafka bootstrap host:port", "my-cluster-kafka-bootstrap:9092")
    .option("--kafka-topic-tweets <topic>", "Kafka topic to tracking tweets send to", "tracking-tweets")
    .option("--kafka-topic-events <topic>", "Kafka topic to tracking events send to", "tracking-events")
    .option("--kafka-client-id <id>", "Kafka client ID", "my-app")
    // Memcached options
    .option(
        "--memcached-hostname <hostname>",
        "Memcached hostname (may resolve to multiple IPs)",
        "my-memcached-service",
    )
    .option("--memcached-port <port>", "Memcached port", "11211")
    .option("--memcached-update-interval <ms>", "Interval to query DNS for memcached IPs", "5000")
    // Database options
    .option("--mariadb-host <host>", "MariaDB host", "my-app-mariadb-service")
    .option("--mariadb-port <port>", "MariaDB port", "3306")
    .option("--mariadb-schema <db>", "MariaDB Schema/database", "popular")
    .option("--mariadb-username <username>", "MariaDB username", "root")
    .option("--mariadb-password <password>", "MariaDB password", "mysecretpw")
    // Misc
    .addHelpCommand()
    .parse()
    .opts();
