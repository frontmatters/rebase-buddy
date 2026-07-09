#!/usr/bin/env bash
# Genereert een wegwerp-repo met 8 commits + branch om Rebaser handmatig te
# testen: cd "$(scripts/fixture-repo.sh)" && git rebase -i main
set -euo pipefail

dir="$(mktemp -d /tmp/rebase-buddy-fixture.XXXXXX)"
cd "$dir"

git init -q -b main
git config user.name "Fixture User"
git config user.email "fixture@example.com"

echo "# Fixture" > README.md
git add README.md
git commit -qm "chore: initial scaffold"

mkdir -p src
cat > src/app.ts <<'EOF'
export function main(): void {
  console.log('hello');
}
EOF
git add src/app.ts
git commit -qm "feat: add app entrypoint"

git switch -qc feature

cat > src/login.ts <<'EOF'
export function login(user: string): boolean {
  return user.length > 0;
}
EOF
git add src/login.ts
git commit -qm "feat: add login form"

echo "export const VERSION = '0.1';" > src/version.ts
git add src/version.ts
git commit -qm "feat: add version constant"

sed -i '' 's/hello/hello, world/' src/app.ts
git add src/app.ts
git commit -qm "fix: greeting typo"

echo "body { margin: 0; }" > src/styles.css
git add src/styles.css
git commit -qm "wip styles"

sed -i '' "s/0.1/0.2/" src/version.ts
git add src/version.ts
git commit -qm "wip bump"

git mv src/login.ts src/auth.ts
cat >> src/auth.ts <<'EOF'

export function logout(): void {}
EOF
git add src/auth.ts
git commit -qm "refactor: rename login module to auth

The login module grew beyond forms, so auth covers the load better.
Also adds a logout stub for the next iteration."

echo "$dir"
