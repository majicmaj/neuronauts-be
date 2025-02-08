const fs = require("fs");
const { parser } = require("stream-json");
const { streamObject } = require("stream-json/streamers/StreamObject");

function loadEmbeddings(filePath) {
  return new Promise((resolve, reject) => {
    const embeddings = {};

    const pipeline = fs
      .createReadStream(filePath)
      .pipe(parser())
      .pipe(streamObject());

    pipeline.on("data", ({ key, value }) => {
      embeddings[key] = value;
    });

    pipeline.on("end", () => {
      console.log("Finished loading embeddings");
      resolve(embeddings);
    });

    pipeline.on("error", (err) => {
      reject(err);
    });
  });
}

module.exports = loadEmbeddings;
