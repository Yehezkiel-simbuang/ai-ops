package main

import "regexp"

// Garis pertahanan kedua: agen menolak perintah yang jelas merusak walau aplikasi (yang sudah mengklasifikasi dan meminta persetujuan)
// terlanjur mengirimkannya. Daftar ini sama dengan BLOCKED di server/src/safety.ts.
type blockRule struct {
	re  *regexp.Regexp
	why string
}

var blockRules = []blockRule{
	{regexp.MustCompile(`(^|[\s;&|])rm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/(\s|$|\*)`), "rm rekursif pada /"},
	{regexp.MustCompile(`(^|[\s;&|])rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(/\*|~/?\s*$|\$HOME)`), "rm rekursif pada direktori sistem/home"},
	{regexp.MustCompile(`\bmkfs(\.\w+)?\b`), "format filesystem"},
	{regexp.MustCompile(`\bdd\b[^|;]*\bof=/dev/`), "dd menulis ke perangkat"},
	{regexp.MustCompile(`>\s*/dev/(sd|nvme|vd|xvd|mmcblk)`), "menimpa perangkat blok"},
	{regexp.MustCompile(`(^|[\s;&|])(shutdown|reboot|halt|poweroff|init\s+[06])\b`), "mematikan atau me-restart mesin"},
	{regexp.MustCompile(`\bsystemctl\s+(reboot|poweroff|halt|kexec)\b`), "mematikan atau me-restart mesin"},
	{regexp.MustCompile(`:\(\)\s*\{\s*:\|:&\s*\};:`), "fork bomb"},
	{regexp.MustCompile(`\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z|da)?sh\b`), "mengunduh lalu langsung menjalankan skrip"},
	{regexp.MustCompile(`\b(passwd|chpasswd|userdel|deluser|usermod\s+-[a-zA-Z]*L)\b`), "mengubah akun pengguna"},
	{regexp.MustCompile(`\bchmod\s+(-R\s+)?[0-7]*777\s+/(\s|$)`), "chmod 777 pada /"},
	{regexp.MustCompile(`\bzpool\s+(destroy|labelclear|export)\b`), "merusak pool ZFS"},
	{regexp.MustCompile(`\bzfs\s+destroy\b`), "menghapus dataset ZFS"},
	{regexp.MustCompile(`\bpvesm\s+remove\b|\bqm\s+destroy\b|\bpct\s+destroy\b`), "menghapus VM/LXC"},
	{regexp.MustCompile(`(?i)\bDROP\s+(DATABASE|SCHEMA)\b`), "DROP DATABASE"},
	{regexp.MustCompile(`\b(iptables|nft|ufw)\b[^;|&]*(-F|flush|disable)\b`), "menghapus aturan firewall"},
	{regexp.MustCompile(`\bcrontab\s+-r\b`), "menghapus seluruh crontab"},
	{regexp.MustCompile(`\bauthorized_keys\b[^;|&]*>`), "menimpa authorized_keys"},
	{regexp.MustCompile(`>\s*/etc/(passwd|shadow|sudoers)`), "menimpa berkas akun"},
}

// Blocked mengembalikan alasan bila perintah harus ditolak.
func Blocked(cmd string) (string, bool) {
	if len(cmd) == 0 {
		return "perintah kosong", true
	}
	if len(cmd) > 4000 {
		return "perintah terlalu panjang", true
	}
	for _, r := range blockRules {
		if r.re.MatchString(cmd) {
			return r.why, true
		}
	}
	return "", false
}
