# neuronauts-be

[![GitHub stars](https://img.shields.io/github/stars/majicmaj/neuronauts-be?style=social)](https://github.com/majicmaj/neuronauts-be/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/majicmaj/neuronauts-be?style=social)](https://github.com/majicmaj/neuronauts-be/network)

Backend server for **Neuronauts** – a real-time multiplayer word guessing game powered by semantic word embeddings.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Setup](#setup)
- [Usage](#usage)
- [Contributing](#contributing)
- [License](#license)

## Overview

The **neuronauts-be** project provides the backend functionalities required to process semantic word embeddings and facilitate real-time multiplayer gameplay. It leverages pre-trained word embeddings from [GloVe](https://nlp.stanford.edu/data/glove.6B.zip) to perform fast and accurate semantic similarity checks.

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/yourusername/neuronauts-be.git
   cd neuronauts-be
   ```

## Setup

### Download and Prepare GloVe Embeddings

The backend relies on the `glove.6B.200d.txt` file for semantic processing. Follow these steps to set up the embeddings:

1. **Download and Extract GloVe:**

   Download the GloVe package and unzip it:

   ```bash
   curl -O https://nlp.stanford.edu/data/glove.6B.zip
   unzip glove.6B.zip
   ```

2. **Place the Embeddings File:**

   Move the `glove.6B.200d.txt` file to the root directory of the project.

3. **Convert GloVe to JSON:**

   Run the provided script to convert the GloVe text file to a JSON format that the backend can more easily process:

   ```bash
   python clove_to_json.py
   ```

   This will generate a JSON file containing the word embeddings for use by the server.

## Usage

Once the setup is complete, you can start the backend server.

```bash
node server.js
```

## Contributing

Contributions are welcome! To contribute:

1. **Fork the Repository**

2. **Create a Feature Branch:**

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Commit Your Changes:**

   ```bash
   git commit -m "Add: description of your feature"
   ```

4. **Push to Your Branch:**

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request:**

   Please include a clear description of your changes and reference any related issues.

For additional details, refer to our [CONTRIBUTING.md](CONTRIBUTING.md) if available.

## License

This project is licensed under the [MIT License](LICENSE).
