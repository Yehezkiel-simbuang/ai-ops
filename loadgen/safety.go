package main

import (
	"fmt"
	"net"
	"net/url"
)

// Pemeriksaan kedua (yang pertama ada di server): setelah nama host di-resolve, SEMUA alamatnya harus privat/lokal,
// kecuali host itu sengaja didaftarkan (AllowPublic). Ini menolak nama yang kelihatannya lokal tetapi menunjuk ke IP publik.

func privateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

type resolver func(host string) ([]net.IP, error)

func lookup(host string) ([]net.IP, error) { return net.LookupIP(host) }

func checkURL(raw string, allowPublic bool, resolve resolver) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return fmt.Errorf("alamat tidak valid: %q", raw)
	}
	if allowPublic {
		return nil
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil {
		if !privateIP(ip) {
			return fmt.Errorf("%s bukan alamat privat", host)
		}
		return nil
	}
	ips, err := resolve(host)
	if err != nil || len(ips) == 0 {
		return fmt.Errorf("host %s tidak bisa di-resolve: %v", host, err)
	}
	for _, ip := range ips {
		if !privateIP(ip) {
			return fmt.Errorf("host %s menunjuk ke alamat publik %s; uji beban hanya boleh ke jaringan lokal", host, ip)
		}
	}
	return nil
}

// checkJob memeriksa target dan semua alamat metrik sebelum uji dimulai.
func checkJob(j *Job, resolve resolver) error {
	if err := checkURL(j.Target, j.AllowPublic, resolve); err != nil {
		return err
	}
	for _, s := range j.Scrape {
		if err := checkURL(s.URL, j.AllowPublic, resolve); err != nil {
			return fmt.Errorf("alamat metrik %q: %w", s.Label, err)
		}
	}
	return nil
}
