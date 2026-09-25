import { GoogleGenAI } from '@google/genai';
import formidable from 'formidable';
import fs from 'fs';

// Disable default body parser for multipart form data
export const config = {
  api: {
    bodyParser: false,
  },
};

// Supported Gemini models as requested: 3.1 Flash Lite, 3.5 Flash, 3.5 Flash Lite, 3.6 Flash, 3.7 Flash, 3.8 Flash
export const SUPPORTED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Format date safely as YYYY-MM-DDTHH:mm (HTML5 datetime-local compliant)
function sanitizeDateTime(dateStr) {
  if (!dateStr) {
    const d = new Date(Date.now() + 86400000 * 7);
    return d.toISOString().slice(0, 16);
  }
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    }
  } catch (e) {}
  return String(dateStr).replace(/:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/, '').slice(0, 16);
}

// Generate fallback schedule when AI quota is reached or service is busy
function getFallbackSchedule(scanType) {
  const now = Date.now();
  if (scanType === 'EXAM_SCHEDULE') {
    const examDate1 = new Date(now + 86400000 * 5);
    const examDate2 = new Date(now + 86400000 * 18);
    return {
      type: 'EXAM_SCHEDULE',
      isFallback: true,
      modelUsed: 'Local Fallback Template',
      warning: 'โควต้า AI ชั่วคราวเต็ม ระบบได้เตรียมกำหนดการสอบตัวอย่างให้คุณตรวจสอบและแก้ไขในหน้านี้ได้ทันที',
      courses: [],
      exams: [
        {
          courseCode: '01204111',
          title: 'สอบกลางภาค (Midterm Exam)',
          date: sanitizeDateTime(examDate1),
          room: 'LH3-201',
        },
        {
          courseCode: '01204212',
          title: 'สอบปลายภาค (Final Exam)',
          date: sanitizeDateTime(examDate2),
          room: 'SC2-315',
        },
      ],
    };
  }

  return {
    type: 'CLASS_SCHEDULE',
    isFallback: true,
    modelUsed: 'Local Fallback Template',
    warning: 'โควต้า AI ชั่วคราวเต็ม ระบบได้เตรียมโครงสร้างตารางเรียนตัวอย่างให้คุณตรวจสอบและแก้ไขในหน้านี้ได้ทันที',
    courses: [
      {
        code: 'CS101',
        name: 'Computer Programming I (โปรแกรมมิ่ง 1)',
        instructor: 'ผศ.ดร. ภาณุพงศ์',
        credit: 3,
        schedule: {
          day: 'MON',
          start: '09:00',
          end: '12:00',
          room: 'LAB-201',
        },
      },
      {
        code: 'ENG201',
        name: 'English for Communication (ภาษาอังกฤษเพื่อการสื่อสาร)',
        instructor: 'อ. รัชชานนท์',
        credit: 3,
        schedule: {
          day: 'WED',
          start: '13:00',
          end: '16:00',
          room: 'LH2-105',
        },
      },
      {
        code: 'MATH101',
        name: 'Calculus I for Engineers (แคลคูลัส 1)',
        instructor: 'รศ.ดร. นิตยา',
        credit: 3,
        schedule: {
          day: 'FRI',
          start: '09:30',
          end: '12:30',
          room: 'SC1-304',
        },
      },
    ],
    exams: [
      {
        courseCode: 'CS101',
        title: 'สอบกลางภาค (Midterm)',
        date: sanitizeDateTime(new Date(now + 86400000 * 14)),
        room: 'LAB-201',
      },
    ],
  };
}

async function generateWithFallback(ai, contents, genConfig, preferredModel = null) {
  let lastError = null;

  // Order models, putting user-preferred model first if specified
  let modelsToTry = [...SUPPORTED_MODELS];
  if (preferredModel && SUPPORTED_MODELS.includes(preferredModel)) {
    modelsToTry = [preferredModel, ...SUPPORTED_MODELS.filter((m) => m !== preferredModel)];
  }

  for (const model of modelsToTry) {
    try {
      console.log(`Calling Gemini model: ${model}`);
      const responsePromise = ai.models.generateContent({
        model,
        contents,
        config: genConfig,
      });

      // 10-second timeout per model
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after 10s for ${model}`)), 10000)
      );

      const response = await Promise.race([responsePromise, timeoutPromise]);
      if (response && response.text) {
        console.log(`Gemini response received with model: ${model}`);
        return { response, modelUsed: model };
      }
    } catch (err) {
      lastError = err;
      const msg = err?.message || '';
      console.warn(`Model ${model} failed:`, msg.slice(0, 100));

      // Quick pause before testing next candidate model
      await sleep(300);
    }
  }

  throw lastError || new Error('All AI models unavailable');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let currentScanType = 'CLASS_SCHEDULE';

  try {
    console.log('Incoming schedule scan request');
    const form = formidable({ maxFileSize: 25 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);
    const uploadedFile = Array.isArray(files.image) ? files.image[0] : files.image;
    const scanTypeRaw = Array.isArray(fields.scanType) ? fields.scanType[0] : fields.scanType;
    const preferredModelRaw = Array.isArray(fields.preferredModel) ? fields.preferredModel[0] : fields.preferredModel;
    currentScanType = scanTypeRaw || 'CLASS_SCHEDULE';

    if (!uploadedFile) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY missing, using fallback schedule template');
      return res.status(200).json(getFallbackSchedule(currentScanType));
    }

    const imageBuffer = fs.readFileSync(uploadedFile.filepath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = uploadedFile.mimetype || 'image/jpeg';

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    let systemInstructions = '';
    if (currentScanType === 'CLASS_SCHEDULE') {
      systemInstructions = `คุณคือระบบ AI ผู้เชี่ยวชาญการอ่าน "ตารางเรียน" ของมหาวิทยาลัยและโรงเรียนไทย
คำสั่ง:
1. วิเคราะห์วิชาเรียน, วันในสัปดาห์, เวลาเริ่ม-สิ้นสุด, ห้องเรียน, รหัสวิชา, หน่วยกิต, อาจารย์
2. วันในสัปดาห์ (schedule.day) ให้ใช้ MON, TUE, WED, THU, FRI, SAT, SUN
3. เวลา (start, end) ใช้รูปแบบ "HH:mm" เช่น "09:00", "12:00"
4. รหัสวิชา (code) ตรวจสอบให้แม่นยำ
5. หน่วยกิต (credit) ให้เป็นตัวเลข (1, 2, 3)
6. ใส่ "exams": []`;
    } else if (currentScanType === 'EXAM_SCHEDULE') {
      systemInstructions = `คุณคือระบบ AI ผู้เชี่ยวชาญการอ่าน "ตารางสอบ" ของมหาวิทยาลัยไทย
คำสั่ง:
1. วิเคราะห์วันและเวลาสอบ, รหัสวิชา, ชื่อการสอบ (กลางภาค/ปลายภาค), ห้องสอบ
2. แปลงปี พ.ศ. เป็น ค.ศ. (พ.ศ. - 543)
3. ส่งออกวันที่สอบ (date) ในรูปแบบ "YYYY-MM-DDTHH:mm"
4. ใส่ "courses": []`;
    } else {
      systemInstructions = `วิเคราะห์ตารางเรียนและตารางสอบของไทย
วันเรียนใช้ MON, TUE, WED, THU, FRI, SAT, SUN
เวลาเรียนใช้ "HH:mm"
วันสอบใช้ "YYYY-MM-DDTHH:mm"`;
    }

    const prompt = `${systemInstructions}
ตอบกลับเป็น JSON Structure ตามโครงสร้างนี้เท่านั้น:
{
  "type": "${currentScanType}",
  "courses": [
    {
      "code": "CS101",
      "name": "Computer Programming",
      "instructor": "ดร. สมชาย",
      "credit": 3,
      "schedule": {
        "day": "MON",
        "start": "09:00",
        "end": "12:00",
        "room": "LAB-1"
      }
    }
  ],
  "exams": [
    {
      "courseCode": "CS101",
      "title": "สอบกลางภาค",
      "date": "2026-10-15T09:00",
      "room": "LH3-201"
    }
  ]
}`;

    let parsedData = null;
    try {
      const { response, modelUsed } = await generateWithFallback(
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
        },
        preferredModelRaw
      );

      const resultText = (response.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(resultText);
      parsedData.modelUsed = modelUsed;

      // Sanitize exam dates to HTML5 datetime-local format
      if (parsedData.exams && Array.isArray(parsedData.exams)) {
        parsedData.exams.forEach((e) => {
          e.date = sanitizeDateTime(e.date);
        });
      }
    } catch (aiErr) {
      console.warn('All AI models failed, serving fallback schedule template:', aiErr?.message?.slice(0, 100));
      parsedData = getFallbackSchedule(currentScanType);
    }

    return res.status(200).json(parsedData);
  } catch (error) {
    console.error('Error handling upload in scan-schedule:', error);
    const fallback = getFallbackSchedule(currentScanType);
    return res.status(200).json(fallback);
  }
}
