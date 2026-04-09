#!/bin/sh
# verify-skills.sh — checks that all bundled Paperclip skills are loadable.
# Called by docker-entrypoint.sh before the server starts.
set -eu

SKILLS_DIR="${PAPERCLIP_SKILLS_DIR:-/app/skills}"
REQUIRED_COUNT=13

if [ ! -d "$SKILLS_DIR" ]; then
    echo "[verify-skills] ERROR: skills directory $SKILLS_DIR does not exist"
    exit 1
fi

found=0
missing=0

for skill_dir in "$SKILLS_DIR"/*/; do
    if [ -d "$skill_dir" ] && [ -f "${skill_dir}SKILL.md" ]; then
        skill_name="$(basename "$skill_dir")"
        echo "[verify-skills] OK   $skill_name"
        found=$((found + 1))
    else
        skill_name="$(basename "$skill_dir")"
        echo "[verify-skills] WARN $skill_name: missing SKILL.md"
        missing=$((missing + 1))
    fi
done

echo "[verify-skills] Found $found skills in $SKILLS_DIR (expected >= $REQUIRED_COUNT)"
if [ "$found" -lt "$REQUIRED_COUNT" ]; then
    echo "[verify-skills] ERROR: too few skills found. Check that .agents/skills/ was copied into $SKILLS_DIR"
    exit 1
fi

if [ "$missing" -gt 0 ]; then
    echo "[verify-skills] WARNING: $missing skill(s) missing SKILL.md — may be incomplete"
fi

echo "[verify-skills] All bundled skills are loadable."
