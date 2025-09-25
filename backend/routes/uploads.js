import express from "express";
import multer from "multer";
import PinataClient from "@pinata/sdk";
import { Readable } from "stream";  

const pinata = new PinataClient({
  pinataApiKey: process.env.PINATA_API_KEY,
  pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY,
});

const router = express.Router();

// use memory storage instead of disk
const upload = multer({ storage: multer.memoryStorage() });

async function uploadBufferToPinata(buffer, filename) {
  const readStream = new Readable();
  readStream.push(buffer);
  readStream.push(null); // end of stream

  const result = await pinata.pinFileToIPFS(readStream, {
    pinataMetadata: { name: filename },
  });
  return `https://coffee-far-termite-270.mypinata.cloud/ipfs/${result.IpfsHash}`;
}

router.post("/upload", upload.single("icon"), async (req, res) => {
  try {
    const { name, symbol, description, walletAddress } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "❌ Token icon is required." });
    }

    // 1. upload icon buffer
    const iconIpfsUri = await uploadBufferToPinata(req.file.buffer, req.file.originalname);

    // 2. create metadata JSON in-memory
    const metadata = {
      name,
      symbol,
      description,
      image: iconIpfsUri,
    };

    const metaBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
    const metadataIpfsUri = await uploadBufferToPinata(metaBuffer, `${walletAddress}_metadata.json`);

    return res.json({
      message: "✅ Icon and metadata uploaded successfully!",
      iconIpfsUri,
      metadataIpfsUri,
    });
  } catch (err) {
    console.error("upload error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
