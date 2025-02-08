import json


def convert_glove_to_json(glove_file_path, output_json_path):
    embedding_dict = {}
    with open(glove_file_path, "r", encoding="utf8") as f:
        for line in f:
            values = line.split()
            word = values[0]
            # Convert the rest of the values to floats
            vector = [float(val) for val in values[1:]]
            embedding_dict[word] = vector

    with open(output_json_path, "w", encoding="utf8") as json_file:
        json.dump(embedding_dict, json_file)
    print(f"Saved {len(embedding_dict)} embeddings to {output_json_path}")


if __name__ == "__main__":
    glove_file = "glove.6B.200d.txt"  # path to your downloaded GloVe file
    output_json = "embeddings.json"
    convert_glove_to_json(glove_file, output_json)
