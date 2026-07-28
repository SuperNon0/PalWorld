# 🔐 Connexion du panel — mise à jour et gestion du mot de passe

Ce guide explique comment **mettre à jour** ton panel Palworld pour bénéficier
du nouveau système de connexion, comment **changer** le mot de passe et comment
le **réinitialiser** si tu l'as oublié.

## Ce que change le nouveau système

- **Un seul compte** : `admin`, protégé par mot de passe. La création/suppression
  de comptes multiples a été retirée.
- **Auto-login via Cloudflare Access** (optionnel) : si tu accèdes au panel
  derrière Cloudflare (login Google), tu es connecté **automatiquement**, sans
  ressaisir le mot de passe. En accès direct sur le réseau local (LAN), le mot de
  passe reste demandé — la porte LAN reste protégée.
- **Tous les onglets accessibles** : plus de distinction de droits par page.

---

## 1. Mettre à jour le panel

### Le plus simple — depuis le panel
1. Ouvre le panel → onglet **Maintenance**.
2. Clique **Mettre à jour le panel**. Il récupère la dernière version depuis
   GitHub et redémarre tout seul.
3. Recharge la page (au besoin, rechargement forcé : `Ctrl + Shift + R`).

### En ligne de commande (sur la VM)
```bash
cd /opt/palworld-src        # dossier du dépôt (adapte si besoin)
sudo -u palworld git pull
sudo systemctl restart palworld-panel
```

---

## 2. Changer le mot de passe du compte admin

Depuis le panel :
1. Onglet **Paramètres**.
2. Bloc **« Mot de passe du panel »**.
3. Saisis le nouveau mot de passe (**8 caractères minimum**) → **Changer le mot
   de passe**.

C'est ce mot de passe qui protège l'accès **direct sur le réseau local**.

---

## 3. Réinitialiser le mot de passe oublié

Si tu ne peux plus te connecter (mot de passe oublié **et** pas d'auto-login
Cloudflare), lance ce script **sur la VM** (console Proxmox ou SSH) :

```bash
sudo bash /opt/palworld/scripts/reset-admin-password.sh
```

- Il demande un **nouveau mot de passe** (ou passe-le en argument :
  `sudo bash /opt/palworld/scripts/reset-admin-password.sh 'MonNouveauMDP'`).
- Il réécrit le compte `admin` et remet les bons droits sur le fichier.
- Reconnecte-toi ensuite sur le panel avec ce nouveau mot de passe.

> 💡 **Astuce de secours** : supprimer le fichier des comptes
> (`sudo rm /opt/palworld/panel-users.json` puis
> `sudo systemctl restart palworld-panel`) remet le mot de passe **d'origine**
> défini à l'installation (dans `/etc/palworld-panel/config.json`). Le script
> ci-dessus est préférable car tu choisis un nouveau mot de passe.

---

## 4. (Optionnel) Activer l'auto-login Cloudflare

Si ton panel est publié derrière **Cloudflare Access** avec un login Google :

1. Onglet **Paramètres** → bloc **« Connexion Google (Cloudflare) »**.
2. (Facultatif) Renseigne **ton email Google** pour n'autoriser l'auto-login
   qu'à toi. Laisse vide pour accepter tout email déjà validé par Cloudflare.
3. Enregistre. En arrivant par Cloudflare, tu seras connecté automatiquement.

> ⚠️ **Sécurité** : l'auto-login fait confiance à l'en-tête ajouté par
> Cloudflare. Sur le LAN, cet en-tête est absent (le mot de passe reste
> demandé), mais un appareil malveillant **sur ton réseau** pourrait le
> falsifier. Pour un usage maison, le risque est faible ; garde un mot de passe
> solide sur le compte admin.
