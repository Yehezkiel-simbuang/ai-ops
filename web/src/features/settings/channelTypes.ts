// Jenis kanal notifikasi: label, petunjuk, dan field konfigurasinya (satu sumber untuk formulir).
import type { ChannelType, NotifyLevel } from '@/api/types';

export interface ChannelField { key: string; label: string; secret?: boolean; default?: string }
export interface ChannelTypeInfo { label: string; hint: string; fields: ChannelField[] }

export const CHANNEL_TYPES: Record<ChannelType, ChannelTypeInfo> = {
  telegram: {
    label: 'Telegram', hint: 'Buat bot lewat @BotFather, kirim satu pesan ke bot itu, lalu ambil chat ID (mis. dari @userinfobot).',
    fields: [{ key: 'token', label: 'Token bot', secret: true }, { key: 'chatId', label: 'Chat ID' }]
  },
  ntfy: {
    label: 'ntfy (push ke ponsel)', hint: 'Pasang aplikasi ntfy di ponsel dan berlangganan ke topik yang sama. Pakai nama topik yang sulit ditebak karena siapa pun yang tahu namanya bisa membaca. Server sendiri juga bisa dipakai (isi URL).',
    fields: [{ key: 'url', label: 'URL server (kosong = https://ntfy.sh)' }, { key: 'topic', label: 'Topik' }, { key: 'token', label: 'Token akses (opsional)', secret: true }]
  },
  webhook: {
    label: 'Webhook (Slack, Discord, umum)', hint: 'Slack: URL Incoming Webhook. Discord: URL webhook kanal.',
    fields: [{ key: 'url', label: 'URL webhook', secret: true }, { key: 'format', label: 'Format: generic, slack, atau discord', default: 'generic' }]
  },
  email: {
    label: 'Email (SMTP)', hint: 'Port 465 = TLS langsung, 587 = STARTTLS. Pakai sandi aplikasi, bukan sandi akun utama.',
    fields: [
      { key: 'host', label: 'Server SMTP' }, { key: 'port', label: 'Port', default: '587' }, { key: 'secure', label: 'Keamanan: tls, starttls, atau none', default: 'starttls' },
      { key: 'user', label: 'Pengguna (opsional)' }, { key: 'pass', label: 'Sandi', secret: true }, { key: 'from', label: 'Dari' }, { key: 'to', label: 'Ke (pisah koma)' }
    ]
  }
};

/** Tingkat terendah yang dikirim SEGERA. Minor masuk ringkasan harian dan Info hanya tercatat, kecuali kanal diatur lebih rendah. */
export const LEVELS: Array<[NotifyLevel, string]> = [['major', 'Major dan Critical (disarankan)'], ['critical', 'Hanya Critical dan permintaan persetujuan'], ['minor', 'Minor, Major, dan Critical'], ['info', 'Semua, termasuk Info']];

export const defaultConfig = (type: ChannelType): Record<string, string> => Object.fromEntries(CHANNEL_TYPES[type].fields.map((f) => [f.key, f.default ?? '']));
