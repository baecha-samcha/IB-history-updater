# 단축키

- `Alt+1`: 기간 추가
- `Alt+2`: 포인트 추가
- `Alt+3`: 흐름 추가

## 운영

이 앱은 라즈베리파이의 MariaDB를 사용하며 systemd 서비스로 실행됩니다.

```bash
npm ci
npm run db:migrate
sudo systemctl restart history-timeline
curl http://127.0.0.1:3000/api/health
```
