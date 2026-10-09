#!/bin/sh
# Toshiba: desde la red de la casa (cable o WiFi) no entra nada.
# La administracion entra por la VPN (tailscale0); punchi.dev sale por el tunel
# de Cloudflare, que es solo de salida. Lo que Docker publica (dockdeck 8088,
# etc.) tambien queda solo por la VPN.
#
# `--quitar` saca todo (lo corre el seguro si algo sale mal).
LAN="enp3s0 wlp2s0"
for ipt in iptables ip6tables; do
  for i in $LAN; do
    $ipt -D INPUT -i $i -j MC-LAN-IN 2>/dev/null
    $ipt -D DOCKER-USER -i $i -m conntrack --ctstate NEW -j DROP 2>/dev/null
  done
  $ipt -F MC-LAN-IN 2>/dev/null; $ipt -X MC-LAN-IN 2>/dev/null
done
[ "$1" = "--quitar" ] && { echo "firewall de la LAN quitado"; exit 0; }

for ipt in iptables ip6tables; do
  $ipt -N MC-LAN-IN
  $ipt -A MC-LAN-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ $ipt = iptables ]; then
    $ipt -A MC-LAN-IN -p icmp -j ACCEPT
    $ipt -A MC-LAN-IN -p udp --sport 67 --dport 68 -j ACCEPT
  else
    $ipt -A MC-LAN-IN -p ipv6-icmp -j ACCEPT
    $ipt -A MC-LAN-IN -p udp --dport 546 -j ACCEPT
  fi
  # La conexion directa de Tailscale.
  $ipt -A MC-LAN-IN -p udp --dport 41641 -j ACCEPT
  $ipt -A MC-LAN-IN -j DROP
  $ipt -N DOCKER-USER 2>/dev/null || true
  for i in $LAN; do
    $ipt -I INPUT 1 -i $i -j MC-LAN-IN
    $ipt -I DOCKER-USER 1 -i $i -m conntrack --ctstate NEW -j DROP
  done
done
echo "firewall de la LAN puesto: desde $LAN no entra nada"
