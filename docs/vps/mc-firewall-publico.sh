#!/bin/sh
# Desde internet (ens3) el VPS solo atiende 80 y 443: las apps, por Traefik.
# Todo lo demas -- SSH, el panel de Coolify, Traefik 8080, lo que se agregue --
# se tira. La administracion entra por la VPN (tailscale0), que no pasa por aca.
#
# Dos lugares, en IPv4 y en IPv6:
# - INPUT: lo que atiende el propio VPS (sshd, docker-proxy de IPv6).
# - DOCKER-USER: lo que Docker publica, que se saltea INPUT. Se mira el puerto
#   ORIGINAL (antes del DNAT) y solo conexiones nuevas: las respuestas y lo que
#   los contenedores piden hacia afuera no se tocan.
#
# `--quitar` saca todo (es lo que corre el seguro si algo sale mal).
PUB=ens3
for ipt in iptables ip6tables; do
  $ipt -D INPUT -i $PUB -j MC-PUBLICO-IN 2>/dev/null
  $ipt -D DOCKER-USER -i $PUB -m conntrack --ctstate NEW -j MC-PUBLICO-FWD 2>/dev/null
  $ipt -F MC-PUBLICO-IN 2>/dev/null; $ipt -X MC-PUBLICO-IN 2>/dev/null
  $ipt -F MC-PUBLICO-FWD 2>/dev/null; $ipt -X MC-PUBLICO-FWD 2>/dev/null
done
[ "$1" = "--quitar" ] && { echo "firewall publico quitado"; exit 0; }

for ipt in iptables ip6tables; do
  $ipt -N MC-PUBLICO-IN
  $ipt -A MC-PUBLICO-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ $ipt = iptables ]; then
    $ipt -A MC-PUBLICO-IN -p icmp -j ACCEPT
  else
    # Sin ICMPv6 no hay vecinos ni rutas en IPv6; DHCPv6 contesta al 546.
    $ipt -A MC-PUBLICO-IN -p ipv6-icmp -j ACCEPT
    $ipt -A MC-PUBLICO-IN -p udp --dport 546 -j ACCEPT
  fi
  # La conexion directa de Tailscale (si no, va por sus relays y anda igual).
  $ipt -A MC-PUBLICO-IN -p udp --dport 41641 -j ACCEPT
  $ipt -A MC-PUBLICO-IN -p tcp -m multiport --dports 80,443 -j ACCEPT
  $ipt -A MC-PUBLICO-IN -p udp --dport 443 -j ACCEPT
  $ipt -A MC-PUBLICO-IN -j DROP
  $ipt -I INPUT 1 -i $PUB -j MC-PUBLICO-IN

  $ipt -N DOCKER-USER 2>/dev/null || true
  $ipt -N MC-PUBLICO-FWD
  $ipt -A MC-PUBLICO-FWD -p tcp -m conntrack --ctorigdstport 80 -j RETURN
  $ipt -A MC-PUBLICO-FWD -p tcp -m conntrack --ctorigdstport 443 -j RETURN
  $ipt -A MC-PUBLICO-FWD -p udp -m conntrack --ctorigdstport 443 -j RETURN
  $ipt -A MC-PUBLICO-FWD -j DROP
  $ipt -I DOCKER-USER 1 -i $PUB -m conntrack --ctstate NEW -j MC-PUBLICO-FWD
done
echo "firewall publico puesto: desde $PUB solo 80/443"
