# Custom File Lock Plugin for Obsidian

## Table of Contents

- [Introduction](#introduction)
- [Problem Statement](#problem-statement)
- [Features](#features)
- [How It Works](#how-it-works)
- [Target Operating Systems](#target-operating-systems)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Introduction

The **Custom File Lock Plugin** is an Obsidian plugin designed to manage file saving behavior by temporarily deferring file saves during editing. It provides control over when files are saved to disk, helping to prevent issues related to rapid or unintended saves, such as conflicts with external synchronization services or version control systems.

## Problem Statement

By default, Obsidian saves changes to files immediately as you type. While this is convenient for most users, it can cause problems in certain scenarios:

- **External Synchronization Conflicts**: When using synchronization tools like Dropbox, Google Drive, or Git, rapid and frequent file saves can lead to synchronization conflicts or unnecessary versioning noise.
- **Performance Issues**: Saving large files or files on network drives can introduce latency or performance degradation when saves occur too frequently.
- **Data Integrity Concerns**: Immediate saves may risk saving unintended or incomplete changes, especially when experimenting with content that you may not wish to keep.

The Custom File Lock Plugin addresses these issues by introducing a controlled save mechanism, allowing you to define when and how often files are saved.

## Features

- **User-Configurable Save Interval**: Set the period during which file changes are kept in memory before being saved to disk, ranging from 1 second to 3600 seconds (1 hour).
- **Controlled Saving**: Prevents immediate saves by intercepting the file modification method and deferring the actual save operation.
- **Lock Period**: Implements a lock period during which changes are accumulated but not saved to disk.
- **Multiple File Handling**: Supports editing multiple files simultaneously, each with its own lock period and save timing.
- **Automatic Unlock and Save**: After the lock period expires, the plugin automatically saves the changes to disk.
- **Data Integrity**: Ensures that the latest content is saved, preventing data loss or overwriting issues.

## How It Works

The plugin intercepts Obsidian's file modification process and introduces a "lock" period during which files are not saved to disk. Instead, changes are kept in memory, and the plugin saves the file after the specified interval or when certain conditions are met.

### Technical Details

- **Overriding `app.vault.modify`**: The plugin overrides the `modify` method of Obsidian's `Vault` class to control file saving.
- **Locked Files Map**: Maintains a map of locked files, tracking their content and associated timers.
- **Content Updates**: Periodically updates the content of locked files by reading from the active editor.
- **Asynchronous Operations**: Handles asynchronous methods properly to ensure smooth operation without blocking the main thread.
- **User Interface**: Provides a settings tab in Obsidian's settings where users can adjust the save interval.
- **Event Handling**: Listens to Obsidian's events to manage file modifications and editor interactions effectively.

## Target Operating Systems

The Custom File Lock Plugin is designed to be **platform-independent** and works on any operating system that supports Obsidian, including:

- **Windows**
- **macOS**
- **Linux**

By avoiding platform-specific file system manipulations (such as changing file permissions), the plugin ensures compatibility across all supported operating systems.

## Installation

### Prerequisites

- **Obsidian**: Make sure you have Obsidian installed. You can download it from the [official website](https://obsidian.md/).

### Steps

1. **Download the Plugin**

   - Clone the repository or download the source code as a ZIP file.

2. **Build the Plugin**

   - Navigate to the plugin's directory in your terminal.
   - Install the dependencies:

     ```bash
     npm install
     ```

   - Build the plugin:

     ```bash
     npm run build
     ```

3. **Install the Plugin in Obsidian**

   - Create a folder named `custom-file-lock-plugin` in your Obsidian vault's `.obsidian/plugins/` directory.
   - Copy the built files (`main.js`, `manifest.json`, and `styles.css` if any) into the `custom-file-lock-plugin` folder.

4. **Enable the Plugin**

   - Open Obsidian.
   - Go to **Settings** > **Community plugins**.
   - Ensure that **Safe mode** is off.
   - Click on **Reload plugins**.
   - Find **Custom File Lock Plugin** in the list and enable it.

## Usage

Once the plugin is installed and enabled, it operates automatically.

### Default Behavior

- **Locking Files**: When you start editing a file, the plugin temporarily locks the file by intercepting the save operation.
- **Deferring Saves**: Obsidian is prevented from saving the file immediately. Changes are kept in memory.
- **Automatic Saving**: After the user-defined lock period, the plugin automatically saves the file.
- **Continuous Editing**: If you continue editing, the lock period resets, and the file is saved after the new interval since the last modification.

### Handling Multiple Files

- The plugin supports editing multiple files at the same time.
- Each file has its own lock period and is saved independently.

## Configuration

### Accessing the Settings

1. Open Obsidian.
2. Go to **Settings** > **Custom File Lock**.

### Setting the Save Interval

- **Save Interval**: The period (in seconds) during which file changes are kept in memory before being saved to disk.
- **Range**: Must be between **1 second** and **3600 seconds** (1 hour).
- **Default**: 10 seconds.

#### Steps to Change the Save Interval

1. In the **Custom File Lock** settings tab, locate the **Save Interval** setting.
2. Enter a value between 1 and 3600 in the text input.
3. The new save interval takes effect immediately.

### Immediate Effect

- Changing the save interval updates all existing timeouts for locked files to match the new interval.
- No need to reload the plugin or Obsidian; changes are applied on the fly.

## Limitations

- **Data in Memory**: Changes are held in memory during the lock period. In the unlikely event of a crash, unsaved changes during the lock period may be lost.
- **No Conflict Resolution**: The plugin does not handle merge conflicts or synchronization issues beyond controlling the save timing.
- **Obsidian Updates**: Future updates to Obsidian's API may affect the plugin's functionality.

## Contributing

Contributions are welcome! If you have ideas for improvements or encounter any issues, please open an issue or submit a pull request on the [GitHub repository](https://github.com/mihasm/custom-file-lock-plugin).

### Development Setup

1. **Clone the Repository**

   ```
   git clone https://github.com/yourusername/custom-file-lock-plugin.git
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

## Testing

Enable the plugin in Obsidian and test your changes.

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
2. Find **Custom File Lock Plugin** in the list.
3. Click on the toggle to disable it.

## Support

If you encounter any issues or have questions, please open an issue on the GitHub repository.

## Acknowledgments

- **Obsidian Community**: Thanks to the Obsidian community for providing an extensible platform and support.

---

**Note**: Always ensure you have backups of your important data. Use this plugin at your own risk.



