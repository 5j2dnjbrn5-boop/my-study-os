import { GoogleGenAI } from '@google/genai';
import formidable from 'formidable';
import fs from 'fs';

// ปิด bodyParser เพื่อให้รับไฟล์ Multipart Form Data ได้
export const config = {
  api: {
    bodyParser: false,
  },
};

// ลำดับโมเดลที่จะใช้ หากโมเดลใดติด 503 / High Demand จะสลับไปโมเดลถัดไปทันที
const CANDIDATE_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateWithFallback(ai, contents, genConfig) {
  let lastError = null;

  for (const model of CANDIDATE_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: genConfig,
        });
        if (response && response.text) {
          console.log(`AI scan success using model: ${model}`);
          return response;
        }
      } catch (err) {
        lastError = err;
        const msg = err?.message || '';
        const isTransient = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('429');
        console.warn(`Model ${model} attempt ${attempt + 1} failed:`, msg);
        if (isTransient && attempt === 0) {
          await sleep(1200);
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error('All AI models are currently unavailable.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. อ่านไฟล์รูปภาพที่ส่งมาจาก Frontend
    const form = formidable({});
    const [fields, files] = await form.parse(req);
    const uploadedFile = Array.isArray(files.image) ? files.image[0] : files.image;

    if (!uploadedFile) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is required' });
    }

    // 2. แปลงไฟล์รูปภาพเป็น Base64
    const imageBuffer = fs.readFileSync(uploadedFile.filepath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = uploadedFile.mimetype || 'image/jpeg';

    // 3. เรียกใช้งาน Gemini API พร้อมระบบ Fallback รองรับช่วง High Demand (503)
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `คุณคือ AI ช่วยอ่านตารางเรียนและตารางสอบจากรูปภาพ
กรุณาวิเคราะห์รูปภาพนี้แล้วตอบกลับเป็น JSON Structure ตามรูปแบบนี้เท่านั้น (ห้ามใส่ Markdown หรือตัวหนังสืออื่น):
{
  "type": "SCHEDULE",
  "courses": [
    {
      "code": "รหัสวิชา",
      "name": "ชื่อวิชา",
      "instructor": "ชื่ออาจารย์ (ถ้ามีหรือ -)",
      "credit": 3,
      "schedule": { "day": "MON", "start": "09:00", "end": "12:00", "room": "ห้องเรียน" }
    }
  ],
  "exams": [
    {
      "courseCode": "รหัสวิชา",
      "title": "ชื่อการสอบ (เช่น Midterm Exam)",
      "date": "2026-10-15T09:00:00",
      "room": "ห้องสอบ"
    }
  ]
}`;

    const response = await generateWithFallback(
      ai,
      [
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        prompt,
      ],
      {
        responseMimeType: 'application/json',
      }
    );

    const resultText = (response.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(resultText);

    // 4. ส่งข้อมูล JSON กลับไปให้ Frontend
    return res.status(200).json(parsedData);
  } catch (error) {
    console.error('Error processing image:', error);
    const rawMsg = error.message || '';
    if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
      return res.status(503).json({
        error: 'โมเดล AI กำลังมีผู้ใช้งานหนาแน่นชั่วคราว (503 High Demand) กรุณาลองใหม่อีกครั้งในอีกสักครู่'
      });
    }
    return res.status(500).json({ error: rawMsg || 'AI processing failed' });
  }
}