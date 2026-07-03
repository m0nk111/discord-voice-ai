// Registers the slash commands with Discord. Called once at startup.

import { REST, Routes } from 'discord.js';
import { config } from './config';

const commands = [
  {
    name: 'join',
    description: 'Join your voice channel',
    options: [
      {
        type: 3, // STRING
        name: 'mode',
        description: 'The mode to join in',
        required: false,
        choices: [
          { name: 'silent', value: 'silent' },
          { name: 'free', value: 'free' },
        ],
      },
    ],
  },
  { name: 'reset', description: 'Reset voice chat history' },
  { name: 'leave', description: 'Leave the voice channel' },
  { name: 'help', description: 'Display help message' },
];

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  await rest.put(Routes.applicationCommands(config.discord.appId), { body: commands });
}
