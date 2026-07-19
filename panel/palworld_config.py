#!/usr/bin/env python3
"""Lecture / écriture du fichier PalWorldSettings.ini de Palworld.

Le fichier a un format particulier : toutes les options sont sur une seule
ligne, sous la forme ``OptionSettings=(Cle=Valeur,Cle2="Valeur 2",...)``.
Ce module sait parser cette ligne, modifier des valeurs et réécrire le
fichier sans casser le format.

Utilisable aussi en ligne de commande :
    palworld_config.py FICHIER get
    palworld_config.py FICHIER set Cle=Valeur [Cle2=Valeur2 ...]
"""
import json
import re
import sys

OPTION_LINE_RE = re.compile(r"^(\s*OptionSettings=\()(.*)(\)\s*)$")


def _split_pairs(inner):
    """Découpe l'intérieur de OptionSettings=(...) sur les virgules hors guillemets."""
    parts = []
    current = ""
    in_quotes = False
    for char in inner:
        if char == '"':
            in_quotes = not in_quotes
            current += char
        elif char == "," and not in_quotes:
            parts.append(current)
            current = ""
        else:
            current += char
    if current:
        parts.append(current)
    return parts


def parse(text):
    """Retourne un dict ordonné {cle: valeur brute} depuis le contenu du .ini."""
    for line in text.splitlines():
        match = OPTION_LINE_RE.match(line)
        if not match:
            continue
        settings = {}
        for part in _split_pairs(match.group(2)):
            if "=" in part:
                key, value = part.split("=", 1)
                settings[key.strip()] = value.strip()
        return settings
    return {}


def render_line(settings):
    inner = ",".join(f"{key}={value}" for key, value in settings.items())
    return f"OptionSettings=({inner})"


def read_settings(path):
    with open(path, encoding="utf-8") as handle:
        return parse(handle.read())


def write_settings(path, updates):
    """Fusionne ``updates`` dans le fichier. Les clés inconnues sont ajoutées."""
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    written = False
    for index, line in enumerate(lines):
        match = OPTION_LINE_RE.match(line)
        if not match:
            continue
        settings = {}
        for part in _split_pairs(match.group(2)):
            if "=" in part:
                key, value = part.split("=", 1)
                settings[key.strip()] = value.strip()
        settings.update(updates)
        indent = match.group(1)[: match.group(1).index("OptionSettings")]
        lines[index] = indent + render_line(settings)
        written = True
        break

    if not written:
        lines += ["[/Script/Pal.PalGameWorldSettings]", render_line(dict(updates))]

    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def unquote(value):
    if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    return value


def quote(value):
    return '"' + str(value).replace('"', "") + '"'


def _main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 1
    path, command = argv[1], argv[2]
    if command == "get":
        print(json.dumps(read_settings(path), indent=2, ensure_ascii=False))
        return 0
    if command == "set":
        updates = {}
        for arg in argv[3:]:
            if "=" not in arg:
                print(f"argument invalide (attendu Cle=Valeur) : {arg}", file=sys.stderr)
                return 1
            key, value = arg.split("=", 1)
            updates[key] = value
        write_settings(path, updates)
        return 0
    print(f"commande inconnue : {command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
