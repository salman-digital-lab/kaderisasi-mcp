// Dashboard vocabulary, taken from kaderisasi-admin-fe (menu labels in
// src/constants/navigation.ts, status labels in src/constants/{options,render},
// column titles on each page). Keep it in sync when the dashboard renames things.

export const GLOSSARY = `## Speak like the admin dashboard

The person asking is a Kaderisasi admin who knows the dashboard (Dasbor Admin Kaderisasi),
not the database. Answer in Indonesian unless they write in another language, and use the
dashboard's words:
- Name things by their dashboard menu and column titles, never by table or column names
  (say "Anggota" and "Jenjang", not "profiles.level"). Mention SQL or tables only if asked.
- Show stored codes as their dashboard label (status 3 on Ruang Curhat → "Sudah Ditangani").
- When it helps, point to where they can see it: "di menu Kegiatan → Pendaftar".

### Menu → data
| Menu (dashboard) | Tables |
| --- | --- |
| Dasbor | aggregates over profiles, activities, registrations |
| Pengumuman | announcements, announcement_recipients |
| Akses & Tiket → Akses Saya / Tinjau Permintaan | tickets |
| Kalender Kegiatan | calendar_events |
| Kegiatan (pendaftar, sertifikat, penilaian, kelas) | activities, activity_registrations, activity_scoring_*, activity_courses |
| Anggota | public_users (akun) + profiles (biodata) |
| Ruang Curhat | ruang_curhats (sensitive: personal problems) |
| Pendaftar P3RI | p3ri_registrations |
| Prestasi & Peringkat → Prestasi / Peringkat Bulanan | achievements / monthly_leaderboards, lifetime_leaderboards |
| Formulir Digital | custom_forms, custom_form_responses |
| Tautan Pendek | urls |
| Klub (pendaftar, anggota, peran) | clubs, club_registrations, club_member_roles, club_courses |
| Kelas | courses, course_lessons, course_documents, course_lesson_progress |
| Sertifikat Digital | certificate_templates, certificate_approvals, issued_certificates |
| Pusat Data → Provinsi / Perguruan Tinggi | provinces, cities, countries / universities |
| Pengaturan → Akun Admin / Peran & Izin | admin_users |
| Perintis (separate Perintis app) | perintis_participants, perintis_journals, perintis_session_reports |
| Talent assessment | talent_assessment_drafts, talent_assessment_results |

### Anggota (members)
- "ID Anggota" = public_users.member_id; "Nama Anggota" = profiles.name.
- "Status Akun": public_users.account_status active → "Aktif", no_account → "Tanpa Akun".
- "Jenjang" (profiles.level, activities.minimum_level, courses.minimum_level):
  0 Jamaah, 3 Aktivis (lulus SSC), 6 Kader (lulus LMD), 10 Kader Lanjut (lulus Spectra).
- "Jenis Kelamin": M → Laki-Laki, F → Perempuan; empty shows as "-" (not filled in).
- "Pendidikan Sekarang" comes from the member's education history; "Lencana" are badges.

### Kegiatan (activities)
- "Tipe Kegiatan" (activities.activity_type): 0 Umum, 1 Umum - Hanya Pendaftaran,
  2 Spiritual Camp (SSC), 3 LMD, 4 Komunitas Profesi (Komprof), 5 SPECTRA, 20 sub-program (child of another activity).
- "Kategori Kegiatan" (activities.activity_category): 0 Pelatihan, 1 Keasramaan,
  2 Kaderisasi, 3 Aktualisasi Diri, 4 Kealumnian.
- Pendaftar status (activity_registrations.status, already Indonesian, show as written):
  TERDAFTAR, DITERIMA, DITERIMA BERSYARAT, TIDAK DITERIMA, LULUS KEGIATAN, LANTIK BERSYARAT,
  TIDAK LULUS. "Lulus" in questions means LULUS KEGIATAN.

### Klub
- "Tipe" (clubs.club_type): UNIT → Unit, CLUB_KEPROFESIAN → Club Keprofesian,
  CLUB_BAHASA → Club Bahasa, AVISMAN_REGIONAL → Avisman Regional.
- Pendaftar klub (club_registrations.status): PENDING → Menunggu, APPROVED → Diterima,
  REJECTED → Ditolak.

### Prestasi
- Status (achievements.status): 0 Menunggu Persetujuan, 1 Diterima, 2 Ditolak.
- Tipe (achievements.type): 0 Kompetensi, 1 Organisasi, 2 Akademik.

### Ruang Curhat
- Status (ruang_curhats.status): 0 Belum Ditangani, 1 Sedang Memilih Jadwal,
  2 Sedang Ditangani, 3 Sudah Ditangani, 4 Batal.
- "Kepemilikan Masalah" (problem_ownership): 0 Diri Sendiri, 1 Teman.
- problem_category is already a label (Kesehatan Mental, Akademik, Keluarga, ...).
- Treat this as confidential: prefer counts and trends; quote a person's problem text only
  when the admin asks for that specific case.

### Other statuses
- Kelas (courses.status) and Formulir/Sertifikat templates: draft → Draf, published → Tayang,
  archived → Diarsipkan; active → Aktif, inactive → Nonaktif.
- Pengumuman (announcements.state): draft → Draf, published → Terkirim, withdrawn → Ditarik.
- Persetujuan sertifikat (certificate_approvals.status): pending → Menunggu persetujuan,
  approved → Disetujui, rejected → Ditolak, cancelled → Dibatalkan.
- Penerima sertifikat: siap diterbitkan, belum lulus, sudah terbit, dicabut (revoked).
- Tiket akses (tickets.status): open → Menunggu, resolved → Selesai, cancelled → Dibatalkan,
  approved → Disetujui, rejected → Ditolak.
- Pendaftar P3RI (p3ri_registrations.status): terdaftar → Terdaftar, diterima → Diterima.
- Formulir Digital feature_type: activity_registration → formulir pendaftaran Kegiatan,
  club_registration → formulir pendaftaran Klub.

### Peran admin (admin_users.role_code / additional_role_codes)
super_admin Super Admin, admin Asisten Manager Program, activity_manager Panitia
Program/Kegiatan, achievement_manager Pengelola Prestasi, club_manager Pengelola Komunitas,
konselor Konselor, perintis_manager Pengelola Perintis, p3ri Panitia P3RI.`;
