-- Penjelasan AI yang tersimpan "selesai" tetapi kosong (model penalaran kehabisan anggaran token) dianggap gagal, supaya terlihat dan bisa diminta ulang.
UPDATE load_tests
   SET ai_status = 'failed', ai_error = 'Model mengembalikan jawaban kosong. Minta ulang.'
 WHERE ai_status = 'done' AND btrim(ai_text) = '';
