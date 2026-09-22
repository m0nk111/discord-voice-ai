import {
  Client,
  GatewayIntentBits,
  Events,
  GuildMember,
  Message,
  VoiceBasedChannel,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  VoiceConnection,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} from '@discordjs/voice';
import fs from 'fs';
import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import prism from 'prism-media';

import { config, validateConfig, speechConfigWarning, buildSystemPrompt } from './config';
import * as llm from './llm';
import { ChatMessage } from './llm';
import * as speech from './speech';
import { registerCommands } from './registerCommands';
import { splitMessage, chunkForSpeech, extractSentences, stripFormatting } from './text';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// ---- Mutable state ----
let connection: VoiceConnection | null = null;
let chatHistory: Record<string, ChatMessage[]> = {};
let threadMemory: Record<string, ChatMessage[]> = {};
let audioqueue: { file: string; index: number }[] = [];
let currentIndex = 0; // next chunk index to play
let scheduled = 0; // chunks scheduled for the current reply
let playing = false; // is the playback loop running
let responseStreaming = false; // is the LLM still streaming the current reply
let currentAbort: AbortController | null = null;

let allowwithouttrigger = false;
let allowwithoutbip = false;
let currentlythinking = false;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---- Startup ----
try {
  validateConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const warning = speechConfigWarning();
if (warning) logToConsole(`! ${warning}`, 'warn', 1);
logToConsole(`Bot triggers: ${config.triggers.join(', ')}`, 'info', 1);
logToConsole(`LLM: ${config.provider} (${llm.activeModel})`, 'info', 1);

if (!fs.existsSync('./recordings')) fs.mkdirSync('./recordings');
if (!fs.existsSync('./sounds')) fs.mkdirSync('./sounds');

client.once(Events.ClientReady, async (readyClient) => {
  fs.readdir('./recordings', (err, files) => {
    if (err) {
      logToConsole('Error reading recordings directory', 'error', 1);
      return;
    }
    files.forEach((file) => fs.unlinkSync(`./recordings/${file}`));
  });

  try {
    await registerCommands();
    logToConsole('> Slash commands registered.', 'info', 2);
  } catch (error) {
    logToConsole(`Error registering commands: ${(error as Error).message}`, 'error', 1);
  }

  logToConsole(`Logged in as ${readyClient.user.tag}!`, 'info', 1);
});

// ---- Slash commands ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Please use this command in a server.', ephemeral: true });
    return;
  }

  const { commandName, options } = interaction;

  switch (commandName) {
    case 'join': {
      if (connection) {
        await interaction.reply({ content: 'I am already in a voice channel. Please use `/leave` first.', ephemeral: true });
        return;
      }
      const channel = interaction.member.voice.channel;
      if (!channel) {
        await interaction.reply({ content: 'You need to join a voice channel first!', ephemeral: true });
        return;
      }

      const mode = options.getString('mode');
      allowwithoutbip = false;
      allowwithouttrigger = false;
      if (mode === 'silent') allowwithoutbip = true;
      else if (mode === 'free') allowwithouttrigger = true;

      // Joining and waiting for the connection to be ready can exceed the 3s
      // interaction window, so defer first.
      await interaction.deferReply({ ephemeral: true });

      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      // Recover from transient disconnects (network blips, being moved channels);
      // give up and leave cleanly if it can't reconnect.
      const conn = connection;
      conn.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          logToConsole('> Voice connection lost — leaving.', 'warn', 1);
          try { conn.destroy(); } catch { /* ignore */ }
          if (connection === conn) connection = null;
        }
      });

      try {
        // Don't record until the connection is ready, or the receiver never
        // gets any audio packets.
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (error) {
        logToConsole(`X Voice connection failed to become ready: ${(error as Error).message}`, 'error', 1);
        try { connection.destroy(); } catch { /* ignore */ }
        connection = null;
        await interaction.editReply({ content: 'Failed to connect to the voice channel.' });
        return;
      }

      logToConsole('> Joined voice channel', 'info', 1);
      handleRecording(connection, channel);
      await interaction.editReply({ content: 'Joined voice channel.' });
      break;
    }

    case 'reset': {
      chatHistory = {};
      await interaction.reply({ content: 'Chat history reset!', ephemeral: true });
      logToConsole('> Chat history reset!', 'info', 1);
      break;
    }

    case 'leave': {
      if (!connection) {
        await interaction.reply({ content: 'I am not in a voice channel.', ephemeral: true });
        break;
      }
      try { connection.destroy(); } catch { /* ignore */ }
      connection = null;
      currentAbort?.abort();
      resetPlayback();
      chatHistory = {};
      logToConsole('> Left voice channel', 'info', 1);
      await interaction.reply({ content: 'Left voice channel.', ephemeral: true });
      break;
    }

    case 'help': {
      await interaction.reply({
        content: `Commands:
\`/join\` - Join your voice channel and listen for the wake word.
\`/join silent\` - Join without the confirmation sounds.
\`/join free\` - Join and respond to everything without a wake word.
\`/reset\` - Reset chat history. You may also say \`reset chat history\` in voice chat.
\`/leave\` - Leave the voice channel. You may also say \`leave voice chat\` in voice chat.
\`/help\` - Display this message.

Say \`stop\` to interrupt the bot while it is speaking.`,
        ephemeral: true,
      });
      break;
    }

    default:
      break;
  }
});

// ---- Text chat & vision ----
client.on(Events.MessageCreate, async (message) => {
  if (!client.user) return;
  if (message.author.id === client.user.id || message.system) return;

  // Bot mentioned with an image while in a voice channel -> react out loud.
  if (
    config.vision &&
    connection &&
    message.mentions.has(client.user) &&
    message.attachments.size > 0 &&
    message.member?.voice.channel
  ) {
    const imageUrl = message.attachments.first()!.url;
    reactToImage(imageUrl, connection);
    return;
  }

  const isMention = message.mentions.has(client.user);
  const isReply = Boolean(message.reference && message.reference.messageId);
  const isInThread = message.channel.isThread() && (await isThreadFromBot(message));

  if (isInThread) {
    await message.channel.sendTyping();
    logToConsole('> Message in thread', 'info', 1);
    const response = await sendToLLMInThread(message, message.channel.id);
    await sendChunkedReply(message, response, false);
  } else if (isReply) {
    const repliedMessage = await message.channel.messages.fetch(message.reference!.messageId!);
    if (repliedMessage.author.id !== client.user.id) return;
    await message.channel.sendTyping();
    logToConsole('> Reply to message', 'info', 1);
    const response = await sendTextToLLM(message);
    await sendChunkedReply(message, response, true);
  } else if (isMention) {
    await message.channel.sendTyping();
    logToConsole('> Mentioned in message', 'info', 1);
    const response = await sendTextToLLM(message);
    await sendChunkedReply(message, response, true);
  }
});

async function sendChunkedReply(message: Message, response: string, replyFirst: boolean): Promise<void> {
  const parts = splitMessage(response);
  for (let i = 0; i < parts.length; i++) {
    try {
      if (i === 0 && replyFirst) await message.reply(parts[i]);
      else if (message.channel.isSendable()) await message.channel.send(parts[i]);
    } catch (error) {
      console.error(`Failed to send message part: ${error}`);
      break;
    }
  }
}

// When a user joins the bot's channel, start listening to them.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!client.user) return;
  if (
    connection &&
    oldState.channelId !== newState.channelId &&
    newState.channelId === connection.joinConfig.channelId &&
    newState.member?.user.id !== client.user.id &&
    newState.channel
  ) {
    logToConsole(`> User joined voice channel: ${newState.member?.user.username}`, 'info', 1);
    handleRecordingForUser(newState.member!.user.id, connection, newState.channel);
  }
});

// ---- Voice recording ----
function subscribeToUser(conn: VoiceConnection, userID: string) {
  const filePath = `./recordings/${userID}.pcm`;
  const writeStream = fs.createWriteStream(filePath);
  const listenStream = conn.receiver.subscribe(userID, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: config.waitTime },
  });
  const opusDecoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
  listenStream.pipe(opusDecoder).pipe(writeStream);
  return { filePath, writeStream };
}

function handleRecording(conn: VoiceConnection, channel: VoiceBasedChannel): void {
  channel.members.forEach((member: GuildMember) => {
    if (member.user.bot) return;
    const { filePath, writeStream } = subscribeToUser(conn, member.user.id);
    writeStream.on('finish', () => {
      logToConsole(`> Audio recorded for ${member.user.username}`, 'info', 2);
      convertAndHandleFile(filePath, member.user.id, conn, channel);
    });
  });
}

function handleRecordingForUser(userID: string, conn: VoiceConnection, channel: VoiceBasedChannel): void {
  const { filePath, writeStream } = subscribeToUser(conn, userID);
  writeStream.on('finish', () => {
    logToConsole(`> Audio recorded for ${userID}`, 'info', 2);
    convertAndHandleFile(filePath, userID, conn, channel);
  });
}

function restartListening(userID: string, conn: VoiceConnection | null, channel: VoiceBasedChannel): void {
  if (!conn) return;
  handleRecordingForUser(userID, conn, channel);
}

function convertAndHandleFile(filePath: string, userid: string, conn: VoiceConnection, channel: VoiceBasedChannel): void {
  const mp3Path = filePath.replace('.pcm', '.mp3');
  ffmpeg(filePath)
    .inputFormat('s16le')
    .audioChannels(1)
    .format('mp3')
    .on('error', (err: Error) => {
      logToConsole(`X Error converting file: ${err.message}`, 'error', 1);
      currentlythinking = false;
      restartListening(userid, conn, channel);
    })
    .save(mp3Path)
    .on('end', () => {
      logToConsole(`> Converted to MP3: ${mp3Path}`, 'info', 2);
      handleTranscription(mp3Path, userid, conn, channel);
    });
}

// ---- Transcription + voice command routing ----
async function handleTranscription(fileName: string, userId: string, conn: VoiceConnection, channel: VoiceBasedChannel): Promise<void> {
  try {
    let transcription = await speech.transcribe(fileName);
    const clean = transcription.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').toLowerCase();

    // Whisper hallucinates these short phrases on silence/background noise.
    // Match the whole utterance (not a substring) so real sentences aren't dropped.
    const spoken = transcription.trim().toLowerCase();
    const hallucinations = ['thank you.', 'thank you', 'thanks for watching', 'thanks for watching!', 'bye.', 'bye', 'you', '.'];
    if (!spoken || hallucinations.includes(spoken)) {
      logToConsole('> Ignoring silence/background noise.', 'info', 2);
      restartListening(userId, conn, channel);
      return;
    }

    logToConsole(`> Transcription for ${userId}: "${transcription}"`, 'info', 1);

    if (currentlythinking && config.stopWords.some((w) => clean.includes(w))) {
      playSound(conn, 'command');
      currentAbort?.abort();
      resetPlayback();
      currentlythinking = false;
      logToConsole('> Bot stopped.', 'info', 1);
      restartListening(userId, conn, channel);
      return;
    }

    if (currentlythinking) {
      logToConsole('> Bot is already thinking, ignoring transcription.', 'info', 2);
      restartListening(userId, conn, channel);
      return;
    }

    const addressed = allowwithouttrigger || config.triggers.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(transcription));
    if (!addressed) {
      currentlythinking = false;
      logToConsole('> Bot was not addressed directly. Ignoring the command.', 'info', 2);
      restartListening(userId, conn, channel);
      return;
    }

    if (transcription.split(' ').length <= 1) {
      currentlythinking = false;
      logToConsole('> Ignoring single word command.', 'info', 2);
      restartListening(userId, conn, channel);
      return;
    }

    for (const name of config.triggers) {
      transcription = transcription.replace(new RegExp(`\\b${name}\\b`, 'i'), '').trim();
    }

    // Voice commands.
    if (clean.includes('reset') && clean.includes('chat') && clean.includes('history')) {
      playSound(conn, 'command');
      currentlythinking = false;
      chatHistory = {};
      logToConsole('> Chat history reset!', 'info', 1);
      restartListening(userId, conn, channel);
      return;
    }
    if (clean.includes('leave') && clean.includes('voice') && clean.includes('chat')) {
      playSound(conn, 'command');
      currentlythinking = false;
      try { conn.destroy(); } catch { /* ignore */ }
      connection = null;
      chatHistory = {};
      logToConsole('> Left voice channel', 'info', 1);
      return;
    }

    // Otherwise, send to the LLM.
    currentlythinking = true;
    playSound(conn, 'understood');
    sendToLLM(transcription, userId, conn);
    restartListening(userId, conn, channel);
  } catch (error) {
    currentlythinking = false;
    logToConsole(`X Failed to transcribe audio: ${(error as Error).message}`, 'error', 1);
    restartListening(userId, conn, channel);
  } finally {
    try {
      fs.unlinkSync(fileName);
      fs.unlinkSync(fileName.replace('.mp3', '.pcm'));
    } catch {
      // Files may already be gone; ignore.
    }
  }
}

// ---- LLM ----
async function sendToLLM(transcription: string, userId: string, conn: VoiceConnection): Promise<void> {
  let messages = chatHistory[userId] || [];
  messages.push({ role: 'user', content: transcription });
  messages = llm.trimHistory(messages);

  const system = buildSystemPrompt(allowwithouttrigger ? 'voiceFree' : 'voice');

  let full = '';
  let buffer = '';
  let ignored = false;
  let spoke = false;

  // Speak a sentence as soon as it's complete (playing the "answer" chime once),
  // so the bot starts talking before the full reply is generated.
  const speak = (sentence: string) => {
    if (!spoke) { playSound(conn, 'result'); spoke = true; }
    void enqueueSpeech(sentence, conn);
  };

  const abort = new AbortController();
  currentAbort = abort;
  responseStreaming = true;

  try {
    await llm.chatStream(system, messages, (delta) => {
      full += delta;
      if (ignored) return;
      // Free mode: the model tags an off-topic message [IGNORING] — stay silent.
      if (/\[IGNORING\]/i.test(full)) { ignored = true; buffer = ''; return; }
      buffer += delta;
      const { sentences, rest } = extractSentences(buffer);
      buffer = rest;
      for (const sentence of sentences) speak(sentence);
    }, abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) {
      logToConsole(`X Failed to communicate with LLM: ${(error as Error).message}`, 'error', 1);
    }
    if (currentAbort === abort) currentAbort = null;
    responseStreaming = false;
    if (!spoke) currentlythinking = false;
    return;
  }

  // Flush the trailing sentence *before* clearing the streaming flag, so the
  // playback loop doesn't finish early and miss it.
  if (!ignored) {
    const rest = buffer.trim();
    if (rest) speak(rest);
  }
  if (currentAbort === abort) currentAbort = null;
  responseStreaming = false;

  logToConsole(`> LLM Response: ${full}`, 'info', 1);

  if (!ignored && full.trim()) {
    messages.push({ role: 'assistant', content: full });
    chatHistory[userId] = messages;
  }
  if (!spoke) currentlythinking = false; // nothing to speak — release the lock
}

async function sendTextToLLM(message: Message): Promise<string> {
  const messageChain: ChatMessage[] = [];
  let currentMessage: Message | null = message;

  while (currentMessage) {
    messageChain.push({
      role: currentMessage.author.id === client.user!.id ? 'assistant' : 'user',
      content: currentMessage.content,
    });
    if (currentMessage.reference?.messageId) {
      try {
        currentMessage = await message.channel.messages.fetch(currentMessage.reference.messageId);
      } catch (error) {
        if ((error as { code?: number }).code === 10008) break;
        throw error;
      }
    } else {
      currentMessage = null;
    }
  }

  messageChain.reverse();
  const messages = llm.trimHistory(messageChain);

  try {
    return await llm.chat(buildSystemPrompt('text'), messages);
  } catch (error) {
    console.error(`Failed to communicate with LLM: ${(error as Error).message}`);
    return 'Sorry, I am having trouble processing your request right now.';
  }
}

async function sendToLLMInThread(message: Message, threadId: string): Promise<string> {
  if (!threadMemory[threadId]) {
    threadMemory[threadId] = [];
    const threadMessages = await message.channel.messages.fetch({ limit: 20 });
    threadMessages.forEach((threadMessage) => {
      threadMemory[threadId].push({
        role: threadMessage.author.id === client.user!.id ? 'assistant' : 'user',
        content: threadMessage.content,
      });
    });
    threadMemory[threadId].reverse();
    threadMemory[threadId].shift();
    threadMemory[threadId].shift();
  }

  let messages = threadMemory[threadId];

  const starter = message.channel.isThread() ? await message.channel.fetchStarterMessage().catch(() => null) : null;
  if (starter) {
    messages.push({
      role: starter.author.id === client.user!.id ? 'assistant' : 'user',
      content: starter.content,
    });
  }

  messages.push({
    role: message.author.id === client.user!.id ? 'assistant' : 'user',
    content: message.content,
  });

  messages = llm.trimHistory(messages);
  threadMemory[threadId] = messages;

  try {
    const response = await llm.chat(buildSystemPrompt('text'), messages);
    threadMemory[threadId].push({ role: 'assistant', content: response });
    logToConsole(`> LLM Text Response: ${response}`, 'info', 1);
    return response;
  } catch (error) {
    console.error(`Failed to communicate with LLM: ${(error as Error).message}`);
    return 'Sorry, I am having trouble processing your request right now.';
  }
}

async function reactToImage(imageUrl: string, conn: VoiceConnection): Promise<void> {
  if (currentlythinking) return; // busy with another reply
  currentlythinking = true;

  if (!config.vision) {
    logToConsole('X Vision is disabled (set VISION=true to enable).', 'info', 1);
    sendToTTS('Sorry, I cannot look at images right now.', conn);
    return;
  }
  try {
    const reaction = await llm.vision(
      buildSystemPrompt('voice'),
      'The user just shared this image in chat. React to it out loud in one or two sentences.',
      imageUrl,
    );
    logToConsole(`> Image reaction: ${reaction}`, 'info', 1);
    playSound(conn, 'result');
    sendToTTS(reaction, conn);
  } catch (error) {
    logToConsole(`X Failed to react to image: ${(error as Error).message}`, 'error', 1);
    sendToTTS('Sorry, I cannot see the image.', conn);
  }
}

// ---- Speech playback ----
// Speak a full block of text (used for image reactions and canned messages).
function sendToTTS(text: string, conn: VoiceConnection): void {
  for (const chunk of chunkForSpeech(text)) void enqueueSpeech(chunk, conn);
}

// Synthesize one chunk and queue it for ordered playback. Indices are reserved
// synchronously, so chunks play in order even though synthesis runs in parallel.
async function enqueueSpeech(text: string, conn: VoiceConnection): Promise<void> {
  const index = scheduled;
  scheduled += 1;
  if (!playing) {
    playing = true;
    void playLoop(conn);
  }
  const clean = stripFormatting(text); // guarantee the TTS never reads Markdown symbols
  if (!clean) {
    audioqueue.push({ file: '', index }); // nothing left to say after stripping
    return;
  }
  try {
    const audioBuffer = await speech.synthesize(clean);
    const filename = `./sounds/tts_${index}.${config.speech.ttsFormat}`;
    fs.writeFileSync(filename, audioBuffer);
    audioqueue.push({ file: filename, index });
  } catch (error) {
    logToConsole(`X Failed to synthesize speech: ${(error as Error).message}`, 'error', 1);
    audioqueue.push({ file: '', index }); // placeholder so playback skips past it
  }
}

// Plays queued chunks in order, waiting for slower synthesis or the next
// streamed sentence, then stops once the whole reply has been spoken.
async function playLoop(conn: VoiceConnection): Promise<void> {
  while (currentIndex < scheduled || responseStreaming) {
    const item = audioqueue.find((a) => a.index === currentIndex);
    if (!item) {
      await sleep(120); // not synthesized yet, or waiting for the next sentence
      continue;
    }
    audioqueue = audioqueue.filter((a) => a.index !== item.index);
    if (item.file) {
      await playOne(conn, item.file);
      try { fs.unlinkSync(item.file); } catch { /* ignore */ }
    }
    currentIndex += 1;
  }
  const spoke = scheduled > 0;
  resetPlayback();
  currentlythinking = false;
  if (spoke) playSound(conn, 'ready'); // "listening again" chime
}

function playOne(conn: VoiceConnection, file: string): Promise<void> {
  return new Promise((resolve) => {
    const player = createAudioPlayer();
    conn.subscribe(player);
    player.play(createAudioResource(file));
    player.on(AudioPlayerStatus.Idle, () => resolve());
    player.on('error', (error) => { logToConsole(`Error: ${error.message}`, 'error', 1); resolve(); });
  });
}

function resetPlayback(): void {
  audioqueue = [];
  currentIndex = 0;
  scheduled = 0;
  playing = false;
  responseStreaming = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playSound(conn: VoiceConnection, sound: string, volume: number | string = 1): void {
  if ((allowwithouttrigger || allowwithoutbip) && sound !== 'command') return;

  if (!fs.existsSync(`./sounds/${sound}.mp3`)) {
    logToConsole(`X Sound file not found: ${sound}.mp3`, 'error', 1);
    return;
  }

  const input = fs.createReadStream(`./sounds/${sound}.mp3`);
  const output = new PassThrough();
  ffmpeg(input)
    .audioFilters(`volume=${volume}`)
    .format('opus')
    .on('error', (err: Error) => console.error(err))
    .pipe(output);

  const resource = createAudioResource(output);
  const player = createAudioPlayer();
  player.play(resource);
  conn.subscribe(player);

  player.on('error', (error) => logToConsole(`Error: ${error.message}`, 'error', 1));
}

// ---- Helpers ----
function logToConsole(message: string, level: 'info' | 'warn' | 'error', _type?: number): void {
  switch (level) {
    case 'warn':
      console.warn(message);
      break;
    case 'error':
      console.error(message);
      break;
    default:
      console.info(message);
      break;
  }
}

async function isThreadFromBot(message: Message): Promise<boolean> {
  if (!message.channel.isThread()) return false;
  const starter = await message.channel.fetchStarterMessage().catch(() => null);
  if (!starter) return false;
  return starter.author.id === client.user!.id;
}

process.on('SIGINT', () => {
  logToConsole('> Shutting down...', 'info', 1);
  try { connection?.destroy(); } catch { /* ignore */ }
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logToConsole(`Unhandled promise rejection: ${reason}`, 'error', 1);
});

client.login(config.discord.token);
