# Obsidian Autosave Control

⚠️ **WARNING** ⚠️: Please use this plugin with caution only on vaults with backed up data because it is in **alpha release**!

## Introduction

The **Obsidian Autosave Control** is an Obsidian plugin designed to manage file saving behavior by temporarily deferring file saves during editing. It provides control over when files are saved to disk, helping to prevent issues related to rapid or unintended saves, such as conflicts with external synchronization services or version control systems.

## Problem Statement

By default, Obsidian saves changes to files immediately as you type. While this is convenient for most users, it can cause problems in certain scenarios:

- **External Synchronization Conflicts**: When using synchronization tools like Dropbox, Google Drive, or Git, rapid and frequent file saves can lead to synchronization conflicts or unnecessary versioning noise.
- **Performance Issues**: Saving large files or files on network drives can introduce latency or performance degradation when saves occur too frequently.
- **Data Integrity Concerns**: Immediate saves may risk saving unintended or incomplete changes, especially when experimenting with content that you may not wish to keep.

The Obsidian Autosave Control addresses these issues by introducing a controlled save mechanism, allowing you to define when and how often files are saved.

## Features

- **User-Configurable Save Interval**: Set the period during which file changes are kept in memory before being saved to disk, ranging from 1 second to 3600 seconds (1 hour). Default: 10 seconds.
- **Lock Period**: Implements a lock period during which changes are accumulated but not saved to disk.
- **Automatic Unlock and Save**: After the lock period expires, the plugin automatically saves the changes to disk.
- **Multiple File Handling**: Supports editing multiple files simultaneously, each with its own lock period and save timing.

## Target Operating Systems

The Obsidian Autosave Control is designed to be platform-independent.

## Installation

### Option 1: Install Using Pre-built Release

If you don't want to manually build the plugin, you can use the pre-built version from the latest release.

1. **Download the Pre-built Release**
   - Go to the [Releases page](https://github.com/mihasm/obsidian-autosave-control/releases) of this repository.
   - Download the latest version of the plugin (`obsidian-autosave-control.zip`).

2. **Install the Plugin in Obsidian**
   - Extract the contents of the `.zip` file.
   - Create a folder named `obsidian-autosave-control` in your Obsidian vault's `.obsidian/plugins/` directory.
   - Copy the extracted files (`main.js`, `manifest.json`) into the `obsidian-autosave-control` folder.

3. **Enable the Plugin**
   - Open Obsidian.
   - Go to **Settings** > **Community plugins**.
   - Ensure that **Safe mode** is off.
   - Click on **Reload plugins**.
   - Find **Obsidian Autosave Control** in the list and enable it.

### Option 2: Build the Plugin Manually

For users who want to build the plugin from the source, follow these steps:

1. **Clone the Repository or Download the Source Code**
   - Clone the repository or download the source code as a ZIP file.

2. **Install Dependencies**
   - Navigate to the plugin's directory in your terminal.
   - Run the following command to install dependencies:

     ```bash
     npm install
     ```

3. **Build the Plugin**
   - Run the following command to build the plugin:

     ```bash
     npm run build
     ```

4. **Install the Plugin in Obsidian**
   - Create a folder named `obsidian-autosave-control` in your Obsidian vault's `.obsidian/plugins/` directory.
   - Copy the built files (`main.js`, `manifest.json`) into the `obsidian-autosave-control` folder.

5. **Enable the Plugin**
   - Open Obsidian.
   - Go to **Settings** > **Community plugins**.
   - Ensure that **Safe mode** is off.
   - Click on **Reload plugins**.
   - Find **Obsidian Autosave Control** in the list and enable it.


## Usage

Once the plugin is installed and enabled, it operates automatically.

### Default Behavior

- **Locking Files**: When you start editing a file, the plugin temporarily locks the file by intercepting the save operation.
- **Deferring Saves**: Obsidian is prevented from saving the file immediately. Changes are kept in memory.
- **Automatic Saving**: After the user-defined lock period, the plugin automatically saves the file.
- **Continuous Editing**: If you continue editing, the lock period resets, and the file is saved after the new interval since the last modification.
- **Exiting Obsidian**: If you exit Obsidian, the plugin intercepts the event and saves all locked files before letting Obsidian quit.
- **Closing Tabs**: If you close the editor tab of a file, the plugin unlocks and saves the file immediately.
- **Switching Files**: If you switch the editor tab of a file to another file, the plugin unlocks and saves the file immediately.

## Configuration

### Accessing the Settings

1. Open Obsidian.
2. Go to **Settings** > **Obsidian Autosave Control**.

- **Save Interval**: The period (in seconds) during which file changes are kept in memory before being saved to disk.
- **Range**: Must be between **1 second** and **3600 seconds** (1 hour).
- **Default**: 10 seconds.

### Immediate Effect

- Changing the save interval updates all existing timeouts for locked files to match the new interval.
- No need to reload the plugin or Obsidian; changes are applied on the fly.

## Limitations

- **Data in Memory**: Changes are held in memory during the lock period. In the unlikely event of a crash, unsaved changes during the lock period may be lost.
- **No Conflict Resolution**: The plugin does not handle merge conflicts or synchronization issues beyond controlling the save timing.
- **Obsidian Updates**: Future updates to Obsidian's API may affect the plugin's functionality.
- ⚠️ **WARNING** ⚠️: Please use this plugin with caution only on vaults with backed up data because it is in **alpha release**!

## Contributing

Contributions are welcome! If you have ideas for improvements or encounter any issues, please open an issue or submit a pull request on the [GitHub repository](https://github.com/mihasm/obsidian-autosave-control).

### Development Setup

1. **Clone the Repository**

   ```
   git clone https://github.com/mihasm/obsidian-autosave-control.git
   ```

2. **Install Dependencies**

  ```
  npm install
  ```

3. **Build**
  ```
  npm run build
  ```
This will watch for changes and rebuild the plugin automatically.

## Link the Plugin for Testing

Create a symbolic link from the plugin's build directory to your Obsidian vault's `.obsidian/plugins/` directory.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

*Disclaimer: This plugin is not affiliated with or endorsed by Obsidian. Use it at your own risk.*

---

## Frequently Asked Questions (FAQ)

### 1. What happens if Obsidian crashes during the lock period?

Changes are kept in memory during the lock period. If Obsidian crashes or is forcefully closed before the changes are saved, unsaved changes during the lock period may be lost. It's recommended to set a reasonable save interval based on your needs to minimize potential data loss.

### 2. Can I set the save interval to more than one hour?

No, the maximum allowed save interval is 3600 seconds (one hour). Storing changes in memory for longer periods increases the risk of data loss in case of a crash.

### 3. Does the plugin affect the performance of Obsidian?

The plugin is designed to be efficient and should not noticeably affect Obsidian's performance. It periodically updates the content of locked files and manages timers for saving files.

### 4. Is the plugin compatible with other Obsidian plugins?

The plugin should be compatible with most other plugins. However, since it overrides Obsidian's file modification method, conflicts could arise if another plugin modifies the same method in a conflicting way.

### 5. How can I disable the plugin?

To disable the plugin:

1. Go to **Settings** > **Community plugins**.
2. Find **Obsidian Autosave Control** in the list.
3. Click on the toggle to disable it.

## Support

If you encounter any issues or have questions, please open an issue on the GitHub repository.

## Acknowledgments

- **Obsidian Community**: Thanks to the Obsidian community for providing an extensible platform and support.

---

**Note**: Always ensure you have backups of your important data. Use this plugin at your own risk.



