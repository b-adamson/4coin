import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import PinataClient from "@pinata/sdk";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pinata = new PinataClient({
  pinataApiKey: process.env.PINATA_API_KEY,
  pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY,
});

const router = express.Router();
const upload = multer({ dest: "uploads/" });

async function uploadFileToPinata(filePath) {
  const stream = fs.createReadStream(filePath);
  try {
    const result = await pinata.pinFileToIPFS(stream, {
      pinataMetadata: { name: path.basename(filePath) },
    });
    return `https://coffee-far-termite-270.mypinata.cloud/ipfs/${result.IpfsHash}`;
  } catch (e) {
    console.error("Pinata error:", e);
    return null;
  }
}

router.post(
  "/upload",
  upload.single("icon"),     // 1) parse multipart -> req.file + req.body
  async (req, res) => {
    const { name, symbol, description, walletAddress } = req.body;
    const date = new Date().toISOString().split("T")[0];
    const prefix = `${walletAddress}_${date}`;

    try {
      if (!req.file) return res.status(400).json({ error: "❌ Token icon is required." });
      const iconPath = req.file.path;

      const iconIpfsUri = await uploadFileToPinata(iconPath);
      if (!iconIpfsUri) return res.status(500).json({ error: "Failed to upload icon to Pinata" });

      const metadata = { name, symbol, description, image: iconIpfsUri };
      const metaPath = path.join(__dirname, "..", "uploads", `${prefix}_metadata.json`);
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

      const metadataIpfsUri = await uploadFileToPinata(metaPath);
      if (!metadataIpfsUri) return res.status(500).json({ error: "Failed to upload metadata to Pinata" });

      res.json({ message: "✅ Icon and metadata uploaded successfully!", iconIpfsUri, metadataIpfsUri });

      try { fs.unlinkSync(iconPath); fs.unlinkSync(metaPath); } catch {}
    } catch (err) {
      console.error("upload error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
