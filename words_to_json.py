import json


def txt_to_json(input_file, output_file):
    # Open the text file and read all lines, stripping off any whitespace/newlines.
    with open(input_file, "r") as f:
        words = [line.strip() for line in f if line.strip()]

    # Write the list of words to a JSON file.
    with open(output_file, "w") as f:
        json.dump(words, f, indent=2)

    print(f"Successfully converted '{input_file}' to '{output_file}'.")


if __name__ == "__main__":
    # Specify the input and output file names.
    input_filename = "google-10000-english-usa-no-swears-medium.txt"
    output_filename = "words_medium.json"

    txt_to_json(input_filename, output_filename)
