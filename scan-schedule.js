import { GoogleGenAI } from '@google/genai';
import formidable from 'formidable';
import fs from 'fs';

// ปิด bodyParser ของ Vercel เพื่อให้รับไฟล์ Multipart Form Data ได้
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. อ่านไฟล์รูปภาพที่ส่งมาจาก Frontend
    const form = formidable({});
    const [fields, files] = await form.parse(req);
    const uploadedFile = files.image?.[0];

    if (!uploadedFile) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    // 2. แปลงไฟล์รูปภาพเป็น Base64
    const imageBuffer = fs.readFileSync(uploadedFile.filepath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = uploadedFile.mimetype || 'image/jpeg';

    // 3. เรียกใช้งาน Gemini API (ดึง GEMINI_API_KEY จาก Environment Variable)
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `คุณคือ AI ช่วยอ่านตารางเรียนและตารางสอบจากรูปภาพ
กรุณาวิเคราะห์รูปภาพนี้แล้วตอบกลับเป็น JSON Structure ตามรูปแบบนี้เท่านั้น (ห้ามใส่ Markdown หรือตัวหนังสืออื่น):
{
  "type": "SCHEDULE", // ใส่ "SCHEDULE" ถ้าเป็นตารางเรียน หรือ "EXAM" ถ้าเป็นตารางสอบ
  "courses": [
    {
      "id": "c1",
      "code": "รหัสวิชา",
      "name": "ชื่อวิชา",
      "instructor": "ชื่ออาจารย์ (ถ้ามี)",
      "credit": 3,
      "schedule": { "day": "MON", "start": "09:00", "end": "12:00", "room": "ห้องเรียน" } // day ใช้ตัวย่อ: MON, TUE, WED, THU, FRI, SAT, SUN
    }
  ],
  "exams": [
    {
      "id": "e1",
      "title": "ชื่อการสอบ (เช่น Midterm Exam)",
      "date": "2026-10-15T09:00:00",
      "room": "ห้องสอบ"
    }
  ]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        prompt,
      ],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const resultText = response.text;
    const parsedData = JSON.parse(resultText);

    // 4. ส่งข้อมูล JSON กลับไปให้ Frontend
    return res.status(200).json(parsedData);
  } catch (error) {
    console.error('Error processing image:', error);
    return res.status(500).json({ error: 'AI processing failed' });
  }
}