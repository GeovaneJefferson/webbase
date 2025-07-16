# Data Guardian

## Description

Data Guardian is an application designed to provide real-time local backups of your important files and folders. It offers features such as:

- Real-time monitoring of selected folders for changes
- Incremental backups to save space and time
- Version history and the ability to restore previous file versions
- Exclusion of specific files or folders from backups
- Backup logs for tracking activities
- User-friendly interface for managing backup settings and devices

## Features

- **Overview:** A dashboard providing a summary of backup status, storage usage, and recent activities.
- **Files:** Browse and manage backed-up files, view version history, and restore previous versions.
- **Devices:** Select and configure the backup destination device.
- **Settings:** Customize backup behavior, including real-time backup activation and other options.
- **Logs:** View and manage backup logs for troubleshooting and monitoring.
- **Time Machine:** Explore previous versions of files with a visual diff viewer for easy comparison and restoration.
- **Selective Backups:** Include or exclude specific folders and subfolders from backups.

## Installation

1.  **Prerequisites:**
    *   Python 3.7 or higher
    *   `pip` (Python package installer)

2.  **Clone the repository:**
    ```bash
    git clone https://github.com/GeovaneJefferson/dataguardian.git
    cd dataguardian
    ```

3.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

4.  **Configuration:**

    *   Run the application to automatically create the initial configuration file at `~/.var/app/io.github.geovanejefferson.dataguardian/config/config.conf`.
    *   Configure the backup device and settings through the application's user interface.

5.  **Running the application:**
    ```bash
    python app.py
    ```

## Usage

1.  Launch the Data Guardian application.

2.  In the "Devices" section, select and confirm your desired backup storage device.

3.  Navigate to the "Overview" section to monitor backup status and storage usage.

4.  In the "Settings" section, enable real-time backup to automatically monitor and back up your files.

5.  Use the "Files" section to browse backed-up files, view previous versions, and restore files if needed.

6.  Manage included and excluded folders in the "Overview" section.

## Development

To contribute to Data Guardian:

1.  Fork the repository.

2.  Create a new branch for your feature or bug fix.

3.  Implement your changes, ensuring proper code style and documentation.

4.  Submit a pull request with a clear description of your changes.

## Contributing

We welcome contributions! Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on how to contribute.

## License

This project is licensed under the [GNU General Public License, version 3 or later](LICENSE).

## Support

For bug reports or feature requests, please open an issue on our [GitHub issues page](https://github.com/GeovaneJefferson/dataguardian/issues).

## Contact

For general inquiries, you can reach out to the project maintainer:

Geovane J. - [Your Email/Contact Link]
