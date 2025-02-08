# neuronauts-be

## Project setup

<!-- Get the Glove 6b 200d file -->

- Download the glove.6B.200d.txt file from https://nlp.stanford.edu/data/glove.6B.zip

```
curl -O https://nlp.stanford.edu/data/glove.6B.zip
unzip glove.6B.zip
```

- Place the file in the root of the project

- Run `clove_to_json.py` to convert the glove file to a json file

```
python clove_to_json.py
```
