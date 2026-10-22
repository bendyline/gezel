---
id: cameras-and-lookouts
title: "Cameras and lookouts: keep an eye on a room"
order: 7.7
summary: Connect a webcam to a project, let gezel notice what happens in view, and tell it what to do when it sees something.
---

# Cameras and lookouts

A project can watch a room through a webcam or a computer's built-in camera. Gezel notices when something moves, can ask an on-device vision model what it sees, and keeps the moments worth keeping. A **lookout** tells it what to watch for and what to do: *when the mud room camera sees the cat squatting on the floor, play the alarm and tell me.*

The pictures never leave your computer unless you say so.

## Add a camera

1. Open the project, then **About → Connections → Add connection**, and choose **Webcam**.
2. Pick the camera and press **Take a test picture** to check the view.
3. Choose **what to keep**:
   - **Moments**: only what the camera found worth noting (the default),
   - **While moving**: a picture every few seconds while something moves,
   - **On a schedule**: a picture every few seconds, from once a second to once a minute,
   - **Nothing**: just the live view.
4. Leave **Recognize what's happening** on if you want the vision model to look at what moves. Lookouts that ask a question need it.

Gezel reads cameras through **ffmpeg**. If it's missing, the setup shows how to install it.

While any camera is watching, the titlebar says so, and the camera's light is on. Click the indicator to pause a camera from anywhere. The emergency stop pauses every camera until you resume each one.

## What it keeps

Every time something happens in view (a person walks through, the cat comes in and sits down), gezel treats it as one **moment**. A moment is saved as a short note in the project with up to three pictures and what the vision model saw, so you and your gezellen can find it later: "when was the cat last in the mud room?"

Saved pictures from **While moving** and **On a schedule** stay in a private folder on this computer, never in a synced folder. They're kept for as many days as you choose, up to a size limit, and the oldest go first. Moments are kept for 90 days.

## Lookouts

Under **Lookouts**, press **Add a lookout** and finish the sentence:

- **When** the camera **sees** anything moving, a person, a pet, or something specific. For something specific, write a yes-or-no question like *Is a cat squatting or pooping on the floor?* Tick **Only when it is clearly happening** to wait for a second picture before acting.
- **Then** tell you, play a sound, say something out loud, send it to your phone, email you, ask a gezel to follow up, or run a craftbook.

Each lookout acts at most once per moment, rests after it acts (10 minutes by default), and stops for the day at its limit. You can limit it to certain hours, snooze it for an hour, or press **Test** to hear and see exactly what it does.

The **Recently** list shows every time a lookout acted, the picture it acted on, and what happened to each action. If something was held, it says why, in plain words. Press **Not this** on a false alarm.

### What needs what

- **Sounds, spoken alerts and notifications** work at every security level.
- **Phone alerts** use the phone channel from Settings.
- **Email** needs a mail account connected to the project and the **Free** security level. A lookout only ever emails the addresses you typed on it.
- **Asking a gezel** and **running a craftbook** need Gezel to be set to run tasks. A gezel on a cloud model can't see the pictures unless you turn on **Let cloud AI see these pictures** for that camera; otherwise the action is held and the list says so.

A gezel can **propose** a lookout, but it stays off until you approve it. Gezellen can never turn on, change, or widen a lookout themselves.

## Privacy

- Pictures, motion detection and the vision model all run on this computer.
- Only gezellen on an on-device model see a camera's pictures. Others get a description made here, unless you allow cloud AI for that camera.
- What the vision model writes is treated as untrusted: a sign held up to the camera can't send an email or start work, because lookouts act only on yes-or-no answers and your own instructions.
- Removing a camera deletes the pictures it saved. The moments it recorded stay in the project until you delete them.
