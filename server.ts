import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const DB_FILE = path.join(process.cwd(), 'chat_history.json');

interface ChatSession {
  sessionId: string;
  studentName: string;
  feeling: string;
  startedAt: string;
  status: 'Aman' | 'Perlu Tindakan';
  notes?: string;
  messages: Array<{
    sender: string;
    timestamp: string;
    text: string;
  }>;
}

let sessions: ChatSession[] = [];
let feelingStats: Record<string, number> = { 'Senang': 0, 'Sedih': 0, 'Marah': 0, 'Biasa saja': 0 };
let totalSessions = 0;

const CRITICAL_KEYWORDS = [
  'bully', 'rundung', 'perkosa', 'ancam', 'bunuh', 'sakit', 'pukul', 
  'pelecehan', 'takut', 'benci', 'meninggal', 'mati', 'depresi', 
  'kekerasan', 'disiksa', 'hajar', 'cubit', 'tampar', 'diperkosa', 'di-bully', 'dibully'
];

function checkSessionStatus(messages: any[]): 'Aman' | 'Perlu Tindakan' {
  for (const msg of messages) {
    const text = (msg.text || '').toLowerCase();
    if (CRITICAL_KEYWORDS.some(kw => text.includes(kw))) {
      return 'Perlu Tindakan';
    }
  }
  return 'Aman';
}

function migrateFlatHistoryToSessions(flatHistory: any[]): ChatSession[] {
  const migratedSessions: ChatSession[] = [];
  
  flatHistory.forEach(msg => {
    const sName = (msg.studentName || 'Anonim').trim();
    const sFeeling = msg.feeling || 'Biasa saja';
    const timestampStr = msg.timestamp || new Date().toLocaleString('id-ID');
    const text = msg.text || '';
    const sender = msg.sender || 'Speak Buddy';
    
    let session = migratedSessions.find(s => s.studentName === sName && s.feeling === sFeeling);
    if (!session) {
      session = {
        sessionId: 'session_' + Math.random().toString(36).substring(2, 11),
        studentName: sName,
        feeling: sFeeling,
        startedAt: timestampStr,
        status: 'Aman',
        messages: []
      };
      migratedSessions.push(session);
    }
    
    session.messages.push({
      sender,
      timestamp: timestampStr,
      text
    });
  });

  migratedSessions.forEach(s => {
    s.status = checkSessionStatus(s.messages);
  });
  
  return migratedSessions;
}

// Load initial data
try {
  if (fs.existsSync(DB_FILE)) {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (data.sessions) {
      sessions = data.sessions;
    } else if (data.globalChatHistory) {
      sessions = migrateFlatHistoryToSessions(data.globalChatHistory);
    } else {
      sessions = [];
    }
    feelingStats = data.feelingStats || { 'Senang': 0, 'Sedih': 0, 'Marah': 0, 'Biasa saja': 0 };
    totalSessions = data.totalSessions || sessions.length;
  }
} catch (e) {
  console.error("Failed to load db:", e);
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      sessions,
      feelingStats,
      totalSessions: sessions.length
    }, null, 2));
  } catch (e) {
    console.error("Failed to save db:", e);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Admin Endpoints
  app.get("/api/admin/stats", (req, res) => {
    const actionNeededCount = sessions.filter(s => s.status === 'Perlu Tindakan').length;
    res.json({
      totalSessions: sessions.length,
      feelingStats,
      actionNeededCases: actionNeededCount
    });
  });

  app.get("/api/admin/sessions", (req, res) => {
    res.json(sessions);
  });

  app.post("/api/admin/sessions/:sessionId/notes", (req, res) => {
    const { sessionId } = req.params;
    const { notes, status } = req.body;
    const session = sessions.find(s => s.sessionId === sessionId);
    if (session) {
      if (notes !== undefined) session.notes = notes;
      if (status !== undefined) session.status = status;
      saveDb();
      res.json({ success: true, session });
    } else {
      res.status(404).json({ error: "Sesi tidak ditemukan" });
    }
  });

  app.get("/api/admin/history", (req, res) => {
    // Reconstruct flat history for backward compatibility
    const flat: any[] = [];
    sessions.forEach(s => {
      s.messages.forEach(m => {
        flat.push({
          sender: m.sender,
          studentName: s.studentName,
          feeling: s.feeling,
          timestamp: m.timestamp,
          text: m.text
        });
      });
    });
    res.json(flat);
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { sessionId, history, message, studentName, feeling } = req.body;
      
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("API Key tidak ditemukan. Pastikan Anda telah mengatur GEMINI_API_KEY.");
      }

      let session = sessions.find(s => s.sessionId === sessionId);
      if (!session && sessionId) {
        session = {
          sessionId,
          studentName: studentName || 'Anonim',
          feeling: feeling || 'Biasa saja',
          startedAt: new Date().toLocaleString('id-ID'),
          status: 'Aman',
          messages: []
        };
        sessions.push(session);
        
        // Update Stats
        totalSessions = sessions.length;
        if (feeling && feelingStats[feeling] !== undefined) {
          feelingStats[feeling]++;
        }
        saveDb();
      }

      if (session && message) {
        session.messages.push({
          sender: 'Siswa',
          timestamp: new Date().toLocaleString('id-ID'),
          text: message
        });
        session.status = checkSessionStatus(session.messages);
        saveDb();
      }

      const ai = new GoogleGenAI({ apiKey });

      const formattedHistory = history.map((msg: any) => ({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

      const systemInstruction = `Kamu adalah Speak Buddy, seorang sahabat virtual yang sangat hangat, empatik, dan pengertian untuk siswa-siswi di SMP BPI 1 Bandung.

Saat ini, kamu sedang menemani mengobrol seorang siswa bernama: ${studentName || 'Siswa'}.
Sebelum mulai chat, ${studentName || 'Siswa'} sudah memilih bahwa perasaannya saat ini sedang: ${feeling || 'Biasa saja'}.

Aturan merespons untuk Speak Buddy:
1. PADA PESAN PERTAMA, kamu harus langsung menyapa ${studentName || 'Siswa'} dengan namanya dan langsung tanggapi perasaan ${feeling || 'Biasa saja'} yang sedang ia rasakan dengan penuh empati. Jangan bertanya lagi "Bagaimana perasaanmu?" karena dia sudah memilihnya di awal.
   - Contoh jika perasaan awal SEDIH: "Halo ${studentName || 'Siswa'}, aku senang kamu mau buka Speak Buddy hari ini. Aku dengar kamu lagi merasa sedih ya? Kalau boleh tahu, ada apa? Aku siap dengerin kok..."
   - Contoh jika perasaan awal MARAH: "Hai ${studentName || 'Siswa'}. Wah, sepertinya hari ini ada hal yang bikin kamu kesal dan marah ya? Keluarin aja semuanya di sini, aku siap nemenin kamu..."
2. Gunakan bahasa Indonesia sehari-hari yang santai, ramah, dan membumi (gunakan kata aku/kamu). Jangan kaku seperti robot, jangan menggurui, dan jangan memberikan ceramah panjang.
3. Posisikan dirimu sebagai teman sebaya tempat curhat yang aman, tepercaya, dan tidak menghakimi. Fokus pada memvalidasi emosi mereka (misal: "Wajar banget kok kalau kamu merasa begitu...").
4. DUKUNGAN LEMBUT TENTANG GURU BK: Jika di tengah percakapan ${studentName || 'Siswa'} membahas masalah yang sangat berat (seperti depresi, keputusasaan, atau menyakiti diri), kamu boleh menyarankan dengan sangat halus bahwa ada Guru BK (Bu Ivo atau Bu Shafira) yang siap membantu lewat WhatsApp di layar. NAMUN JANGAN MEMAKSA. Jika siswa menolak atau belum mau, jangan pernah bahas lagi atau mendesak. Teruslah menjadi pendengar yang baik dan temani dia mengobrol dengan nyaman. Jangan sampai responmu terasa mengganggu.

*BATASAN & KEAMANAN*

*1. Identitas & Peran*
- Kamu BUKAN psikolog, dokter, atau tenaga medis profesional
- Selalu ingatkan klien bahwa kamu adalah pendamping awal, bukan pengganti konselor atau psikolog profesional
- Jangan pernah membuat diagnosis medis atau psikologis (depresi klinis, gangguan kecemasan, PTSD, dll)
- Jangan meresepkan atau menyarankan obat-obatan apapun
- Tidak boleh mengklaim bisa "menyembuhkan" kondisi apapun

*2. Topik yang Tidak Boleh Dibahas*
- Konten seksual atau romantis dalam bentuk apapun
- Informasi tentang cara membuat atau menggunakan senjata
- Detail cara penggunaan narkoba atau zat berbahaya
- Konten yang mendorong perilaku kriminal
- Informasi yang bisa membahayakan diri klien atau orang lain
- Politik, agama, atau ideologi yang memecah belah
- Gosip, fitnah, atau membicarakan pihak ketiga secara negatif

*3. Protokol Krisis — WAJIB DIJALANKAN*
Jika klien menunjukkan tanda-tanda berikut, LANGSUNG jalankan protokol ini:

*4. Tanda-tanda krisis:*
- Menyebut ingin menyakiti diri sendiri atau bunuh diri
- Menyebut ingin menyakiti orang lain
- Mengungkapkan sedang dalam situasi kekerasan aktif
- Mengalami disorientasi berat atau tidak sadar realita

*5. Protokol yang harus dijalankan:*
1. Validasi perasaan mereka dengan tenang, jangan panik
2. JANGAN lanjutkan sesi konseling biasa
3. Sampaikan dengan hangat bahwa situasi ini butuh bantuan profesional
4. Berikan informasi darurat berikut:
   - Hotline kesehatan jiwa: 119 ext 8 (24 jam, gratis)
   - Into The Light Indonesia: 119 ext 8
   - Hubungi orang terpercaya terdekat (orang tua, guru, teman dekat)
   - Jika dalam bahaya fisik: hubungi 110 (Polisi) atau 118 (Ambulans)
- Tetap dampingi dengan tenang hingga klien berkomitmen mencari bantuan

*6. Batasan Berdasarkan Usia*
Anak-anak (6–12 tahun):
- Tidak membahas topik dewasa (hubungan romantis, seksualitas, kekerasan detail)
- Jika menyebut kekerasan atau pelecehan, SEGERA arahkan untuk memberitahu orang tua atau guru terpercaya
- Gunakan bahasa sederhana, hindari istilah teknis psikologi
- Selalu dorong untuk melibatkan orang tua dalam penyelesaian masalah

Remaja (13–18 tahun):
- Tidak membahas konten seksual eksplisit
- Jika menyebut pacaran atau hubungan, bahas hanya dari sisi emosi dan komunikasi yang sehat
- Jika ada indikasi kekerasan dalam rumah tangga atau pelecehan, arahkan ke guru BK, orang tua terpercaya, atau hotline anak: Telepon Sahabat Anak 129
- Tidak mendorong keputusan besar tanpa melibatkan orang tua/wali

Dewasa (19 tahun ke atas):
- Hormati privasi dan otonomi keputusan klien
- Tidak menghakimi pilihan hidup klien
- Tetap berikan perspektif seimbang untuk keputusan besar

*7. Privasi & Kerahasiaan*
- Tidak menyimpan atau mengulang informasi sensitif klien secara tidak perlu
- Tidak menanyakan data pribadi yang tidak relevan (nama lengkap, alamat, nomor HP)
- Jika klien berbagi informasi pihak ketiga, tidak ikut menghakimi orang yang diceritakan
- Ingatkan klien bahwa percakapan ini bersifat pendamping, bukan rekam medis resmi

*8. Batasan Percakapan*
- Jika klien menjadi kasar, tidak sopan, atau melecehkan, tegur dengan lembut dan tetapkan batas yang jelas. Contoh: "Saya di sini untuk membantu kamu, tapi kita perlu menjaga percakapan yang saling menghormati ya."
- Jika klien terus memaksa keluar dari topik konseling, arahkan kembali dengan lembut
- Tidak melayani permintaan yang jelas-jelas bukan untuk konseling (mengerjakan tugas, membuat konten, dll)
- Maksimal fokus pada 1-2 masalah utama per sesi agar tidak overwhelming

*9. Transparansi*
- Jika ditanya "Apakah kamu AI?", jawab jujur: ya, kamu adalah asisten AI yang dirancang untuk bimbingan konseling
- Jika tidak tahu jawaban atas sesuatu, akui dengan jujur dan arahkan ke sumber yang tepat
- Tidak berpura-pura memiliki pengalaman hidup pribadi`;

      // We don't have the history passed directly in constructor for chats.create in this SDK version,
      // so we use generateContent with formatted history array.
      const contents = [
        { role: 'user', parts: [{ text: systemInstruction }]},
        { role: 'model', parts: [{ text: 'Mengerti. Aku siap menjadi Speak Buddy dan akan mematuhi semua instruksi tersebut.' }]},
        ...formattedHistory
      ];

      if (message) {
        contents.push({ role: 'user', parts: [{ text: message }]});
      } else if (history.length === 0) {
        // Trigger first message
        contents.push({ role: 'user', parts: [{ text: "Mulai obrolan" }]});
      }

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
      });

      if (session) {
        session.messages.push({
          sender: 'Speak Buddy',
          timestamp: new Date().toLocaleString('id-ID'),
          text: response.text
        });
        session.status = checkSessionStatus(session.messages);
        saveDb();
      }

      res.json({ text: response.text });
    } catch (error: any) {
      console.error("Error in /api/chat:", error);
      
      let errorMessage = error.message || "Terjadi kesalahan internal pada server.";
      
      try {
        if (errorMessage.startsWith('{')) {
          const parsedError = JSON.parse(errorMessage);
          if (parsedError.error && parsedError.error.message) {
            errorMessage = parsedError.error.message;
          }
        }
      } catch (e) {}

      if (error.status === 401 || errorMessage.includes('invalid authentication credentials') || errorMessage.includes('API_KEY_INVALID')) {
        errorMessage = "API Key yang dimasukkan tidak valid. Mohon pastikan Anda menggunakan Gemini API Key yang benar (biasanya diawali dengan 'AIza...').";
      } else if (errorMessage.toLowerCase().includes('high demand') || errorMessage.toLowerCase().includes('overloaded') || error.status === 503 || error.status === 429) {
        errorMessage = "Maaf, server AI sedang penuh karena banyak yang menggunakan. Coba tunggu beberapa detik dan kirim lagi ya.";
      }

      res.status(500).json({ error: errorMessage });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
