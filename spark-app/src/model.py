from pyspark.sql.types import IntegerType, StringType, StructType, StructField
from pyspark.ml.classification import LogisticRegression
from pyspark.ml.feature import IDF, Tokenizer, StringIndexer, CountVectorizer
from pyspark.ml import PipelineModel
from pyspark.ml.classification import LogisticRegression
from pyspark.ml.evaluation import BinaryClassificationEvaluator, MulticlassClassificationEvaluator
from session import spark

_MODEL_PATH = '/app/model/'


def _read_data():
    schema = StructType([
        StructField("polarity", IntegerType(), True),
        StructField("id", StringType(), True),
        StructField("date", StringType(), True),
        StructField("query", StringType(), True),
        StructField("author", StringType(), True),
        StructField("tweet", StringType(), True),
    ])
    df = spark.read.csv(
        'file:///app/tweets.1600000.processed.noemoticon.csv',
        inferSchema=True,
        header=False,
        schema=schema,
    )
    df.dropna()

    # Remove neutral tweets
    df = df.where(df.polarity != 2)

    print('Tweets data schema')
    df.printSchema()
    return df


def _split_data(df):
    print('Splitting data into train/test')
    df_train, df_test = df.randomSplit([0.90, 0.10], seed=42)
    print('Data distribution')
    print(
        f'Train data - negative: {df_train.where(df_train.polarity == 0).count()}, positive: {df_train.where(df_train.polarity == 4).count()}'
    )
    print(
        f'Test data - negative: {df_test.where(df_test.polarity == 0).count()}, positive: {df_test.where(df_test.polarity == 4).count()}'
    )
    return df_train, df_test


def _preprocess_data(df_train, df_test):
    print('Tokenizing words')
    tokenizer = Tokenizer(inputCol="tweet", outputCol="words")

    print('Applying count vectorizer')
    count_vectorizer = CountVectorizer(inputCol="words", outputCol='count_vector')

    print('Applying inverse document frequency')
    inverse_document_frequency = IDF(inputCol='count_vector', outputCol="features")

    string_indexer = StringIndexer(inputCol="polarity", outputCol="label")

    print('Preprocessing train data')
    df_train = tokenizer.transform(df_train)
    vectorizer = count_vectorizer.fit(df_train)
    df_train = vectorizer.transform(df_train)
    idf = inverse_document_frequency.fit(df_train)
    df_train = idf.transform(df_train)
    str_idx = string_indexer.fit(df_train)
    df_train = str_idx.transform(df_train)

    print('Preprocessing test data')
    df_test = tokenizer.transform(df_test)
    df_test = vectorizer.transform(df_test)
    df_test = idf.transform(df_test)
    df_test = str_idx.transform(df_test)

    return {'data': (df_train, df_test), 'preprocessing_steps': (tokenizer, vectorizer, idf)}


def _get_metrics(predictions):
    # AUC-ROC
    evaluator = BinaryClassificationEvaluator(rawPredictionCol='rawPrediction', labelCol='label')
    auc = evaluator.evaluate(predictions)

    # Accuracy, Precision, and Recall
    multi_evaluator = MulticlassClassificationEvaluator(labelCol='label', predictionCol='prediction')
    accuracy = multi_evaluator.evaluate(predictions, {multi_evaluator.metricName: 'accuracy'})
    precision = multi_evaluator.evaluate(predictions, {multi_evaluator.metricName: 'weightedPrecision'})
    recall = multi_evaluator.evaluate(predictions, {multi_evaluator.metricName: 'weightedRecall'})

    print(f'AUC-ROC: {auc:.4f}')
    print(f'Accuracy: {accuracy:.4f}')
    print(f'Precision: {precision:.4f}')
    print(f'Recall: {recall:.4f}')


def _save_model(*stages):
    print('Saving model')
    model_pipeline = PipelineModel(stages=[*stages])
    model_pipeline.write().overwrite().save(_MODEL_PATH)
    return model_pipeline


def train_model():
    df = _read_data()

    df_train, df_test = _split_data(df)

    preprocessing = _preprocess_data(df_train, df_test)
    df_train, df_test = preprocessing['data']

    print('Initializing model')
    logistic_regression = LogisticRegression(featuresCol='features', labelCol='label')

    print('Training model')
    model = logistic_regression.fit(df_train)

    print('Evaluating model')
    predictions = model.transform(df_test)

    _get_metrics(predictions)

    print('Prediction schema')
    predictions.printSchema()

    model_pipeline = _save_model(*preprocessing['preprocessing_steps'], model)
    return model_pipeline


def load_model():
    return PipelineModel.load(_MODEL_PATH)