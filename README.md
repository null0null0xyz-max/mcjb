# Minecraft Control Panel

Render Web Service для управления Minecraft Paper через SSH. Репозиторий не содержит ключей.

## Render environment variables

`PANEL_PASSWORD` — отдельный пароль панели.
`MC_SSH_HOST` — SSH-хост Instabox.
`MC_SSH_PORT` — `2222`.
`MC_SSH_USER` — пользователь SSH.
`MC_SSH_PRIVATE_KEY` — приватный ключ в формате PEM, только в Render Secret Environment Variables.
`SESSION_SECRET` — Render генерирует автоматически через `render.yaml`.

Пользователь Render должен иметь возможность подключиться по SSH к машине, а SSH-пользователь должен выполнять `sudo systemctl start|stop|restart minecraft` без интерактивного пароля.

Важно: Free Web Service Render может засыпать после периода без HTTP-запросов. Он не является постоянным Minecraft-хостом и не заменяет playit или systemd на игровой машине.
